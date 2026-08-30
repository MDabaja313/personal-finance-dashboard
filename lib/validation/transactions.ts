/**
 * Transaction form input → validated domain values.
 *
 * Built from the CP1 primitives (`zUuid`, `zOptionalUuid`, `zNotFuture`,
 * `zMoneyCents`) plus the kind/sign/category rules in `lib/types/enums.ts`, so
 * no rule here has a second definition anywhere. Pure: Zod and `lib/types`
 * only — no DAL, no clock, no env. ESLint enforces that for
 * `lib/validation/**` and `lib/write-posture.test.ts` proves the fence fires.
 *
 * ## What this layer is and is not
 *
 * It is a UX layer, and every rule it applies is also applied by the database:
 * `transactions_sign_by_kind_ck`, `transactions_adjustment_no_category_ck`, the
 * column-scoped GRANT, the operation-specific RLS policies, and
 * `assert_transaction_refs()`. What validation buys is a message a person can
 * act on *before* a query is issued, and a field to attach it to.
 *
 * There are three rules it deliberately cannot check, because checking them
 * needs data this layer is not allowed to read: whether the account exists and
 * is active, whether the category exists and is active, and whether the
 * category's kind matches the transaction's. Those belong to the mutation
 * layer's preflight (for the message) and to `assert_transaction_refs()` (for
 * the enforcement).
 *
 * ## Four decisions worth stating outright
 *
 * **No owner id is accepted from the caller, ever.** There is no `userId` field
 * on any schema here and there must never be one: the owner comes from
 * `getOwnerId()` inside the mutation DAL, verified from the request's own
 * claims. A form field naming an owner would be an authorization decision made
 * by untrusted input.
 *
 * **The amount field is a non-negative magnitude; the server derives the
 * sign.** `zMoneyCents()` defaults to `allowNegative: false` and these schemas
 * keep that default, then apply `signedAmountFor(kind, magnitude)`. A signed
 * field would let a well-formed submission contradict its own kind — a
 * negative "income", a positive "expense" — and the only way to resolve that
 * contradiction is to pick one and silently discard the other. Deriving
 * removes it. Zero survives as zero: a zero-amount ordinary row is legal
 * (a fully discounted order, a waived fee), which is why the database's sign
 * check is non-strict.
 *
 * **`today` is a parameter, so these are factories.** `makeCreateTransactionSchema(today)`
 * and `makeUpdateTransactionSchema(today)` take the owner's *own* calendar day,
 * supplied by the action from `getToday()` — which derives it from
 * `profiles.timezone`, not from the server's clock. A validator that read the
 * clock itself could not be tested at a fixed date and would disagree with the
 * database's own ceiling, which is computed in the owner's timezone by
 * `assert_transaction_refs()`. The two must agree, so they read the same
 * source.
 *
 * **The kind list is `ORDINARY_TRANSACTION_KINDS`, not `TRANSACTION_KINDS`.**
 * A movement leg cannot be created or edited alone without leaving a movement
 * with one leg, and an adjustment is a CP5 reconciliation outcome the database
 * refuses to let an ordinary UPDATE produce. Both exclusions are enforced again
 * below the form; this is the first of the layers, not the only one.
 */
import { z } from "zod";

import type { CalendarDate, Cents } from "@/lib/types";
import {
  ORDINARY_TRANSACTION_KINDS,
  signedAmountFor,
  type OrdinaryTransactionKind,
} from "@/lib/types/enums";
import { zMoneyCents } from "@/lib/validation/money";
import {
  NAME_MAX_LENGTH,
  zNotFuture,
  zOptionalUuid,
  zUuid,
} from "@/lib/validation/primitives";

/**
 * `public.transaction_kind`, narrowed to the three kinds a form may submit.
 *
 * Anything else — including a perfectly valid `transfer` or `adjustment` —
 * fails as an unselected type rather than with a message explaining which
 * kinds exist. The wording is deliberate: the control only ever offers three
 * options, so a fourth arriving means a hand-crafted request, and telling it
 * which values would have worked is a courtesy owed to a person filling in a
 * form, not to a caller probing an endpoint.
 */
export const zOrdinaryTransactionKind: z.ZodType<OrdinaryTransactionKind, string> = z
  .string({ error: "Select a type." })
  .refine((value): value is OrdinaryTransactionKind =>
    (ORDINARY_TRANSACTION_KINDS as readonly string[]).includes(value), { error: "Select a type." });

/**
 * The payee/counterparty. Its own wording rather than `zName`'s, because
 * "Enter a name." under a Merchant field reads as a bug — the same reason
 * `zInstitution` exists in `lib/validation/accounts.ts`.
 */
export const zMerchant = z
  .string({ error: "Enter a merchant." })
  .trim()
  .min(1, { error: "Enter a merchant." })
  .max(NAME_MAX_LENGTH, { error: `Use ${NAME_MAX_LENGTH} characters or fewer.` });

/**
 * The amount, as a non-negative magnitude — never a signed figure.
 *
 * `allowNegative: false` is `zMoneyCents`'s default and is stated explicitly
 * here anyway: it is the single most consequential option on this form, and a
 * default that changed would otherwise flip the meaning of every stored amount
 * without a diff touching this file.
 */
const zAmountMagnitude = zMoneyCents({ allowNegative: false });

export interface TransactionCreateInput {
  /**
   * The client-generated idempotency key, used verbatim as the row's `id`.
   *
   * Ordinary transaction creation is the first operation in this application
   * where a double submit produces a *real* duplicate — two coffees, same
   * amount, same day, both entirely plausible — so there is nothing about the
   * row itself that could distinguish a retry from a second purchase. The form
   * generates one UUID per logical submission and posts it; a retry therefore
   * collides with itself on the primary key rather than inserting a second row.
   * See `lib/data/mutations/transactions.ts` for what happens on that
   * collision.
   */
  readonly id: string;
  readonly accountId: string;
  readonly date: CalendarDate;
  readonly merchant: string;
  readonly kind: OrdinaryTransactionKind;
  readonly categoryId?: string;
  /** Already signed by `signedAmountFor` — the form never submits a sign. */
  readonly amountCents: Cents;
}

export interface TransactionUpdateInput {
  readonly id: string;
  readonly accountId: string;
  readonly date: CalendarDate;
  readonly merchant: string;
  readonly kind: OrdinaryTransactionKind;
  readonly categoryId?: string;
  readonly amountCents: Cents;
}

/**
 * The fields both forms share, and the transform that derives the sign.
 *
 * The object keys are the form control `name`s, so
 * `z.flattenError(...).fieldErrors` can be handed straight to `invalid()` and
 * land under the right input; the transform renames them to the domain field
 * names the mutation layer takes.
 *
 * `categoryId` stays optional throughout: an uncategorized ordinary row is
 * legal in this schema and always has been (`030-constraints.sql` pins it), so
 * an unselected category picker submits `""`, which `zOptionalUuid` turns into
 * `undefined` rather than failing as a malformed UUID.
 */
function transactionFields(today: CalendarDate) {
  return {
    accountId: zUuid,
    date: zNotFuture(today),
    merchant: zMerchant,
    kind: zOrdinaryTransactionKind,
    categoryId: zOptionalUuid,
    amount: zAmountMagnitude,
  };
}

/** Shared shape → the domain input, with the sign derived from the kind. */
function toDomain(value: {
  accountId: string;
  date: CalendarDate;
  merchant: string;
  kind: OrdinaryTransactionKind;
  categoryId?: string;
  amount: Cents;
}): Omit<TransactionCreateInput, "id"> {
  return {
    accountId: value.accountId,
    date: value.date,
    merchant: value.merchant,
    kind: value.kind,
    categoryId: value.categoryId,
    amountCents: signedAmountFor(value.kind, value.amount),
  };
}

/**
 * The create form, parameterized by the owner's calendar day.
 *
 * `id` is validated as a UUID like any other untrusted field — it arrives from
 * a hidden input, which is exactly as trustworthy as a visible one. A
 * malformed key is reported under `id`, where no control exists to show it;
 * that is intentional, because a person cannot fix it and the form-level
 * message is what they will actually see.
 */
export function makeCreateTransactionSchema(today: CalendarDate) {
  return z
    .object({ id: zUuid, ...transactionFields(today) })
    .transform((value): TransactionCreateInput => ({ id: value.id, ...toDomain(value) }));
}

/**
 * The edit form, parameterized by the owner's calendar day.
 *
 * Structurally identical to create apart from what `id` means: here it names
 * an existing row rather than proposing one. Every editable column is
 * resubmitted whole rather than as a patch — the form always has all of them,
 * and a partial update would need "absent means unchanged" semantics that
 * `date` and `amount` cannot express (blank is a legitimate mistake, not a
 * request to keep the old value).
 *
 * The kind list is the ordinary one here too, and that is what stops an edit
 * from being a back door: retyping an expense into an `adjustment` would
 * otherwise be a two-step path to writing a CP5 row. The database refuses it
 * as well, in `transactions_update_own_ordinary`'s `WITH CHECK`.
 */
export function makeUpdateTransactionSchema(today: CalendarDate) {
  return z
    .object({ id: zUuid, ...transactionFields(today) })
    .transform((value): TransactionUpdateInput => ({ id: value.id, ...toDomain(value) }));
}

/**
 * Delete. Just the row id — whether the row may be deleted depends on what
 * references it (a paid bill occurrence) and on what kind it is (a movement
 * leg), neither of which is a property of the input. Those live in the
 * mutation DAL and in `transactions_delete_own_non_movement`.
 */
export const transactionDeleteSchema = z.object({ id: zUuid });
