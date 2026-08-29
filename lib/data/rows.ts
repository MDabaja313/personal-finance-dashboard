/**
 * Hand-written database row shapes — the *input* side of `lib/data/mappers.ts`.
 *
 * These describe what PostgREST puts on the wire for the explicit column lists
 * the Phase 6 queries select. They are deliberately **not** DTOs: nothing in
 * `app/**`, `components/**`, or `lib/finance/**` ever sees one. Every row
 * crosses into the domain through a mapper, which is what keeps a schema
 * column from silently widening a DTO.
 *
 * Hand-written rather than `supabase gen types` output (DEVELOPMENT_PLAN.md's
 * stated decision): there is no committed codegen artifact to drift, and the
 * nullability below is transcribed from `supabase/migrations/**` — which is
 * the authority, not this file.
 *
 * Two conventions:
 *
 * - **`BIGINT` columns are typed `number | string`.** Phase 4 empirically
 *   verified that local PostgREST serializes `bigint` — including the two
 *   view-computed columns — as an unquoted JSON number. The union is drift
 *   defense against a differing PostgREST/driver configuration, not a
 *   contradiction of that finding, and it forces every consumer through
 *   `centsFrom()` rather than trusting the wire type. A string that parses to
 *   an unsafe integer throws instead of truncating.
 * - **Enum columns are typed `string`.** The wire gives text; narrowing to the
 *   DTO union is a runtime validation step in the mapper, not an assertion.
 *
 * Phase 7 CP4 added `MovementRow` and `MovementLegRow`. Through Phase 6 there
 * was deliberately no such shape — `authenticated` held no SELECT grant on
 * `movements` and needed none, since `Transaction.movementId` is a plain
 * `transactions.movement_id` column and nothing joined to the parent. The
 * movement *edit* surface is the first thing that has to read the pair as one
 * object rather than as two independently listed legs, so the grant and the
 * row shape arrive together with it.
 */

/** A `BIGINT` column as it arrives over the wire — see the note above. */
export type BigIntColumn = number | string;

/**
 * `public.profiles`, timezone projection only. Read by the Checkpoint 4 clock;
 * the rest of the row (`created_at`/`updated_at`) is never selected.
 */
export interface ProfileTimezoneRow {
  timezone: string;
}

/**
 * `public.account_balances` — the `security_invoker` view, which is the read
 * path for accounts. The base `public.accounts` table is never queried
 * directly in Phase 6: `balance_cents` is derived
 * (`opening_balance_cents + SUM(ledger)`) and only the view exposes it.
 * `opening_balance_cents` is on the view too but is not selected — it is not
 * on the `Account` DTO.
 */
export interface AccountBalanceRow {
  id: string;
  name: string;
  institution: string;
  /** `public.account_type` — validated into `AccountType` by the mapper. */
  type: string;
  is_archived: boolean;
  balance_cents: BigIntColumn;
  /** Null = not applicable to this account type (non-credit accounts). */
  credit_limit_cents: BigIntColumn | null;
  /** INTEGER basis points, not cents. Null = not applicable (non-credit/loan). */
  interest_rate_bps: number | null;
}

/**
 * `public.categories`.
 *
 * `is_archived` is selected as of Phase 7 CP2. Archived rows are still
 * *returned* — this list resolves category names for historical transactions,
 * and filtering them out would blank the labels on old rows — but the DTO now
 * carries the flag, so a management surface can show archive state and a
 * future new-entry picker can hide archived options.
 */
export interface CategoryRow {
  id: string;
  name: string;
  /** `public.category_kind` — 'income' | 'expense'. */
  kind: string;
  is_archived: boolean;
}

/**
 * `public.transactions`. `created_at` is an ordering key only — PostgREST can
 * order by a column that isn't selected, and it must never appear on the DTO.
 */
export interface TransactionRow {
  id: string;
  account_id: string;
  /** DATE, 'YYYY-MM-DD'. */
  date: string;
  merchant: string;
  /** `public.transaction_kind`. */
  kind: string;
  /** Null on movement legs, and legally null on an uncategorized ordinary row. */
  category_id: string | null;
  /** Non-null iff `kind` is a movement kind. */
  movement_id: string | null;
  amount_cents: BigIntColumn;
}

/** `public.budgets`. */
export interface BudgetRow {
  id: string;
  category_id: string;
  /** 'YYYY-MM'. */
  period: string;
  limit_cents: BigIntColumn;
}

/**
 * `public.bills`. `due_date` is deliberately absent — it is not a column on
 * this table. A `Bill` DTO's `dueDate` is projected from the earliest
 * `scheduled` occurrence, which is why `toBill()` takes it as a parameter.
 * `anchor_date` and `is_archived` drive the query but are not on the DTO.
 */
export interface BillRow {
  id: string;
  name: string;
  amount_cents: BigIntColumn;
  /** `public.bill_frequency`. */
  frequency: string;
  category_id: string | null;
  account_id: string | null;
}

/**
 * `public.bill_occurrences`, next-scheduled projection. `id` is selected
 * purely as an ordering tie-break, so the reduction stays deterministic even
 * if one bill somehow has two scheduled occurrences on the same date.
 */
export interface BillOccurrenceRow {
  id: string;
  bill_id: string;
  /** DATE, 'YYYY-MM-DD'. */
  due_date: string;
}

/**
 * `public.goal_balances` — the `security_invoker` view. `saved_cents` is
 * derived from `goal_contributions` and exists only here. `archived_at` is on
 * the view and drives the `IS NULL` filter, but is not on the `Goal` DTO.
 */
export interface GoalBalanceRow {
  id: string;
  name: string;
  target_cents: BigIntColumn;
  /** DATE or null — a goal need not have a target date. */
  target_date: string | null;
  saved_cents: BigIntColumn;
}

/**
 * `public.net_worth_snapshots`. `month` is part of the composite primary key
 * `(user_id, month)`; there is no surrogate id, which is why the DTO has none.
 */
export interface NetWorthSnapshotRow {
  /** 'YYYY-MM'. */
  month: string;
  assets_cents: BigIntColumn;
  liabilities_cents: BigIntColumn;
  net_worth_cents: BigIntColumn;
}

/**
 * `public.goal_balances`, widened with `archived_at` for the Phase 7 CP6
 * management read (`getGoalsForManagement()`) — the ordinary `getGoals()`
 * read stays on the narrower `GoalBalanceRow` above, since it deliberately
 * never needs to know archive state.
 */
export interface GoalBalanceManagementRow extends GoalBalanceRow {
  archived_at: string | null;
}

/**
 * `public.goal_contributions`, projected for history display (Phase 7
 * CP6). `created_at` is an ordering key only, like `TransactionRow`'s —
 * PostgREST can order by a column that isn't selected, and it must never
 * appear on the DTO.
 */
export interface GoalContributionRow {
  id: string;
  goal_id: string;
  amount_cents: BigIntColumn;
  /** DATE, 'YYYY-MM-DD'. */
  occurred_on: string;
  note: string | null;
}

/**
 * `public.movements` — the parent of exactly two transaction legs (Phase 7
 * CP4). `user_id` is filtered on but never selected, and `created_at` is not
 * read at all: a movement's date lives on its legs, not here.
 */
export interface MovementRow {
  id: string;
  /** `public.movement_kind` — narrower than `transaction_kind` by design. */
  kind: string;
}

/**
 * One leg of a movement, projected for reconstructing the pair.
 *
 * A narrower selection than `TransactionRow` on purpose: `merchant` is derived
 * by `public.create_movement` from the movement's kind and the other account's
 * name, so it is never read back into an edit form, and `kind`/`category_id`
 * are fixed by the movement (`validate_movement()` assert 3, and
 * `transactions_movement_no_category_ck`) rather than being per-leg facts.
 *
 * `movement_id` is typed nullable to match the column, even though the query
 * that produces these rows filters it to a non-null set.
 */
export interface MovementLegRow {
  id: string;
  movement_id: string | null;
  account_id: string;
  /** DATE, 'YYYY-MM-DD'. */
  date: string;
  amount_cents: BigIntColumn;
}
