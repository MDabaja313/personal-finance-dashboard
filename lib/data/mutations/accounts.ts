import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { centsFrom } from "@/lib/data/mappers";
import { refreshCurrentSnapshotAfter } from "@/lib/data/mutations/snapshots";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, notFound } from "@/lib/errors";
import type { AccountType, Cents } from "@/lib/types";
import type { AccountCreateInput, AccountUpdateInput } from "@/lib/validation/accounts";

/**
 * The write half of the accounts DAL — the first mutating code in this
 * application.
 *
 * ## The rules this module is built to keep
 *
 * **The owner is never a parameter.** Every function here calls `getOwnerId()`
 * and uses what it returns. There is no `userId` argument to pass, so there is
 * nothing for a caller to get wrong: a Server Action is an independently
 * reachable endpoint that may never have rendered a guarded layout, so the
 * identity has to be re-established here, from the request's own verified
 * claims, on every single write.
 *
 * **Every statement still carries an explicit owner predicate**, exactly as the
 * Phase 6 reads do. RLS (`accounts_insert_own`, `accounts_update_own`) is the
 * enforced floor and stays that way; the `.eq("user_id", ownerId)` on top of it
 * is defense in depth, and it is what makes a foreign id return "no rows"
 * rather than depending solely on a policy being correct.
 *
 * **No navigation, no revalidation.** `next/navigation` and `next/cache` are
 * fenced out of `lib/data/mutations/**` by ESLint. Both signal by throwing, and
 * the action layer's `attempt()` catches everything — a redirect issued from
 * here would be swallowed and reported as a generic failure while the
 * navigation silently never happened. Those are the Server Action's decisions,
 * taken after this returns.
 *
 * **Errors are typed, never raw.** Every failed response goes through
 * `mapWriteError`, which never quotes a PostgREST message — a write error's
 * payload is the worst one to quote, since it embeds the failing row.
 *
 * ## Why the preflights exist
 *
 * `updateAccount` and `setAccountArchived` read before they write. That is not
 * an authorization check — RLS and the column-scoped GRANT are — it is an
 * error-quality check. Without it, archiving an account that still holds money
 * comes back as SQLSTATE 23514 from `accounts_guard_update()` and reaches the
 * person as "Some of the information entered is not valid", which is both
 * wrong and unactionable. With it, the action can say what actually happened.
 *
 * The database guard is not thereby redundant, and must never be removed on the
 * strength of these checks: `authenticated` now holds a direct UPDATE privilege
 * on this table, and PostgREST is reachable from a browser with nothing but a
 * session token. A rule enforced only here is enforced only for callers who
 * choose to come through here.
 */

/** What a preflight needs to know about an existing account. */
interface AccountWriteContext {
  readonly type: AccountType;
  readonly openingBalanceCents: Cents;
  readonly balanceCents: Cents;
  readonly isArchived: boolean;
}

/**
 * The owned account behind `accountId`, or `not_found`.
 *
 * Reads `account_balances` rather than `accounts` because the derived balance
 * is only available there — the base table stores the opening figure alone.
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's account" and "no such account" are deliberately
 * indistinguishable to the caller: telling them apart would confirm the
 * existence of another owner's row.
 */
async function readAccountContext(accountId: string): Promise<AccountWriteContext> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("account_balances")
    .select("type, opening_balance_cents, balance_cents, is_archived")
    .eq("id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the account");

  const rows = data as {
    type: string;
    opening_balance_cents: number | string;
    balance_cents: number | string;
    is_archived: boolean;
  }[];

  if (rows.length !== 1) throw notFound("That account does not exist.");

  const row = rows[0];
  return {
    type: row.type as AccountType,
    openingBalanceCents: centsFrom(row.opening_balance_cents, "account_balances.opening_balance_cents"),
    balanceCents: centsFrom(row.balance_cents, "account_balances.balance_cents"),
    isArchived: row.is_archived,
  };
}

/**
 * The account's current type, for the caller to parameterize
 * `accountUpdateSchema()` with.
 *
 * Exported separately because the *type* has to be known before the form input
 * can be validated (a credit limit is legal only on a credit account), while
 * the rest of the context is only interesting once there is a validated input
 * to check against it.
 */
export async function getAccountTypeForUpdate(accountId: string): Promise<AccountType> {
  return (await readAccountContext(accountId)).type;
}

/**
 * Creates an account and returns its id.
 *
 * `is_archived` is not set: it is not in the CP2 INSERT grant, and a new
 * account arriving already archived would be a row nothing can be entered
 * against. `id` and `created_at` are likewise omitted so the database chooses
 * both — a column absent from a column-scoped INSERT grant simply takes its
 * default.
 *
 * The two optional columns are written as explicit `null` rather than left out,
 * so the row's shape does not depend on which keys happened to be present in
 * the input object.
 */
export async function createAccount(input: AccountCreateInput): Promise<string> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("accounts")
    .insert({
      user_id: ownerId,
      name: input.name,
      institution: input.institution,
      type: input.type,
      opening_balance_cents: input.openingBalanceCents,
      credit_limit_cents: input.creditLimitCents ?? null,
      interest_rate_bps: input.interestRateBps ?? null,
    })
    .select("id")
    .single();

  if (error) throw mapWriteError(error, "the account");

  const row = data as { id: string } | null;
  if (!row) throw mapWriteError(new Error("insert returned no row"), "the account");

  // A new account arrives with an opening balance, which lands in the current
  // month's assets or liabilities immediately. See
  // `lib/data/mutations/snapshots.ts` for why this is best-effort and why it
  // runs after the write rather than inside it.
  await refreshCurrentSnapshotAfter("the account");

  return row.id;
}

/**
 * Updates the editable metadata on one owned account.
 *
 * `type` and `user_id` are absent from the payload and from the CP2 UPDATE
 * grant, so neither can move. `opening_balance_cents` is included, and the
 * preflight is what keeps that safe: it is the only stored balance figure —
 * current balance is derived as opening + SUM(ledger) — so changing it on an
 * account that already has transactions silently restates every balance that
 * account has ever reported, including ones already written into
 * `net_worth_snapshots`. `accounts_guard_update()` enforces the same rule in
 * the database; this preflight exists to name it in the failure.
 *
 * The `conflict` classification is deliberate rather than `invalid_input`: the
 * submitted figure is perfectly well formed, it is the account's history that
 * makes it unacceptable. That distinction is what lets the action print a
 * specific sentence instead of "check your input".
 */
export async function updateAccount(input: AccountUpdateInput): Promise<void> {
  const ownerId = await getOwnerId();
  const context = await readAccountContext(input.id);

  // Absent means "leave it alone" (lib/validation/accounts.ts explains why the
  // edit form cannot prefill it), and an unchanged value is not a change — so
  // renaming an account with fifty transactions never trips the rule below.
  const changesOpeningBalance =
    input.openingBalanceCents !== undefined &&
    input.openingBalanceCents !== context.openingBalanceCents;

  if (changesOpeningBalance && (await hasTransactions(input.id))) {
    throw conflict("The opening balance cannot change once the account has transactions.");
  }

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("accounts")
    .update({
      name: input.name,
      institution: input.institution,
      credit_limit_cents: input.creditLimitCents ?? null,
      interest_rate_bps: input.interestRateBps ?? null,
      // Omitted entirely when absent — writing the stored value back would
      // still be a write, and would need the column in the payload for a
      // change nobody asked for.
      ...(input.openingBalanceCents === undefined
        ? {}
        : { opening_balance_cents: input.openingBalanceCents }),
    })
    .eq("id", input.id)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the account");

  // Only the opening balance can move a snapshot figure. A rename, an
  // institution, a credit limit and an interest rate are all metadata the
  // snapshot writer never reads, so a refresh after one would be a whole-user
  // aggregate recomputation for a change that cannot alter a single number in
  // it.
  if (changesOpeningBalance) await refreshCurrentSnapshotAfter("the account");
}

/**
 * Archives or unarchives one owned account.
 *
 * Archiving requires a derived balance of exactly zero. An archived account is
 * excluded from net worth and from the asset/liability totals
 * (`lib/finance/accounts.ts`), so archiving one that still holds money would
 * make that money vanish from every total while its transactions stayed
 * visible in history. Unarchiving is unconditional — it can only restore a
 * figure to the totals, never hide one, and refusing it would make a mistaken
 * archive permanent.
 *
 * Both halves are re-enforced by `accounts_guard_update()`.
 */
export async function setAccountArchived(accountId: string, archived: boolean): Promise<void> {
  const ownerId = await getOwnerId();
  const context = await readAccountContext(accountId);

  if (archived && !context.isArchived && context.balanceCents !== 0) {
    throw conflict("An account can only be archived once its balance is zero.");
  }

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("accounts")
    .update({ is_archived: archived })
    .eq("id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the account");

  // The snapshot writer's account inclusion rule is `is_archived = false`, so
  // this flag is one of the inputs to every figure it computes — which makes a
  // refresh correct in both directions, and it is not symmetric.
  //
  // *Archiving* usually changes nothing: it requires a derived balance of
  // exactly zero, and a zero balance contributes zero to assets and to
  // liabilities alike. But "zero *now*" is not "zero as of this month's last
  // calendar day" — an account whose history nets to zero today can hold a
  // nonzero as-of balance at a month-end the writer computes against.
  // *Unarchiving* changes things routinely: an account archived with history
  // (or seeded archived, as `Old Checking (Closed)` is) rejoins every total the
  // moment the flag flips.
  //
  // Deriving which of those applies would mean reimplementing the writer's
  // as-of query here to decide whether to call the writer. Refreshing
  // unconditionally is both cheaper and correct.
  await refreshCurrentSnapshotAfter("the account");
}

/**
 * Whether the owned account has any transaction at all.
 *
 * `head: true` with an exact count asks PostgREST for the count and no rows,
 * so this stays O(1) on the wire regardless of how much history the account
 * has. The owner predicate is applied on `transactions` as well as on the
 * account, so this can never count a row it is not entitled to see.
 */
async function hasTransactions(accountId: string): Promise<boolean> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { count, error } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the account");

  return (count ?? 0) > 0;
}
