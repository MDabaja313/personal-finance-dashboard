/**
 * Recurring-bill form input → validated domain values.
 *
 * Built from the CP1 primitives (`zName`, `zUuid`, `zOptionalUuid`,
 * `zCalendarDate`, `zMoneyCents`). Pure: Zod and `lib/types` only — no DAL, no
 * clock, no env. ESLint enforces that for `lib/validation/**` and
 * `lib/write-posture.test.ts` proves the fence fires.
 *
 * **No owner id is accepted from the caller, ever.** The owner comes from
 * `getOwnerId()` inside the mutation DAL, and from `auth.uid()` inside the
 * three RPCs.
 *
 * ## The anchor date carries no ceiling and no floor
 *
 * `anchorDate` is the recurrence anchor *and* the first due date this
 * dashboard tracks, and both a past and a future value are ordinary. A bill
 * set up today for a lease starting in November anchors in the future; an
 * invoice entered a week late anchors in the past and is legitimately overdue
 * the moment it is created. So `zNotFuture` is deliberately absent here —
 * unlike a transaction's `date` or an occurrence's `paidOn`, an anchor is not
 * a claim that something already happened.
 *
 * What the anchor is *not* is a licence to back-fill. Generation from an anchor
 * in the past happens exactly once, at creation
 * (`public.maintain_bill_schedule`); every later rebuild starts at the owner's
 * today, so no edit can manufacture an obligation on a date that has passed.
 *
 * ## The amount is a non-negative magnitude, and the database says nothing
 *
 * `bills.amount_cents` carries no CHECK constraint at all — unlike
 * `budgets.limit_cents` (`>= 0`) or `goals.target_cents` (`> 0`) — and CP7
 * deliberately does not add one: inventing a schema rule that the approved
 * design never stated would change what a `bills` row is allowed to mean.
 * The form still collects a non-negative figure, because "how much is due" is
 * a magnitude and a minus sign in that field is a typo rather than an
 * instruction. Zero survives as zero (a tracked obligation whose amount varies
 * and is not yet known is a real thing), which is why there is no `> 0`
 * refinement.
 *
 * ## Category and account stay optional, in both directions
 *
 * Both columns are nullable by design (docs/database-schema.md §4), and a
 * recurring obligation is perfectly trackable without either. An unselected
 * `<select>` submits `""`, which `zOptionalUuid` maps to `undefined` rather
 * than failing as a malformed UUID — and the mutation layer writes an explicit
 * `null`, so clearing a previously-set category is expressible.
 *
 * Two rules this layer deliberately cannot check, because checking them needs a
 * database read: whether a named category is active, and whether a named
 * account is active. Both are the mutation layer's preflight (for the message)
 * and `assert_bill_refs()` (for the enforcement).
 *
 * A category's **kind is deliberately unconstrained** at every layer. No
 * approved pre-CP7 requirement makes a bill's category an expense category —
 * `bills.category_id` carries no CHECK, and no document states a kind rule for
 * it. CP6's budgets rule does not transfer: for a budget "expense" is what the
 * row means, while for a bill the category is a label on a recurring
 * obligation.
 */
import { z } from "zod";

import type { BillFrequency, CalendarDate, Cents } from "@/lib/types";
import { BILL_FREQUENCIES } from "@/lib/types/enums";
import { zMoneyCents } from "@/lib/validation/money";
import { zCalendarDate, zName, zOptionalUuid, zUuid } from "@/lib/validation/primitives";

/**
 * The recurrence selector, narrowed from the single canonical label set.
 *
 * Every one of the four is writable — unlike `TRANSACTION_KINDS`, there is no
 * subset of bill frequencies a person may not choose, because a frequency
 * describes an arrangement rather than a system-derived outcome.
 */
export const zBillFrequency: z.ZodType<BillFrequency, string> = z
  .string({ error: "Select how often this repeats." })
  .refine((value): value is BillFrequency => (BILL_FREQUENCIES as readonly string[]).includes(value), {
    error: "Select how often this repeats.",
  });

/** The fields create and edit share — every editable column of a bill. */
const billFields = {
  name: zName,
  amount: zMoneyCents({ allowNegative: false }),
  frequency: zBillFrequency,
  anchorDate: zCalendarDate,
  categoryId: zOptionalUuid,
  accountId: zOptionalUuid,
};

export interface BillInput {
  readonly id: string;
  readonly name: string;
  readonly amountCents: Cents;
  readonly frequency: BillFrequency;
  readonly anchorDate: CalendarDate;
  readonly categoryId?: string;
  readonly accountId?: string;
}

function toBillInput(value: {
  id: string;
  name: string;
  amount: Cents;
  frequency: BillFrequency;
  anchorDate: CalendarDate;
  categoryId?: string;
  accountId?: string;
}): BillInput {
  return {
    id: value.id,
    name: value.name,
    amountCents: value.amount,
    frequency: value.frequency,
    anchorDate: value.anchorDate,
    categoryId: value.categoryId,
    accountId: value.accountId,
  };
}

/**
 * The create form. `id` is a client-generated idempotency key, used verbatim
 * as the row's `id` — the same arrangement as every other create surface here.
 * Two bills with the same name, amount and frequency are a legitimate pair
 * (two phone lines, two insurance policies), so nothing about the contents
 * could tell a retry apart from a genuine second one; only a stable key can.
 * `lib/data/mutations/bills.ts` explains the retry contract.
 */
export const billCreateSchema = z
  .object({ id: zUuid, ...billFields })
  .transform(toBillInput);

/**
 * The edit form. Structurally identical to create apart from what `id` means:
 * a bill keeps its id for life, so every occurrence's composite FK back to
 * `(bills.id, user_id)` stays valid across an edit.
 *
 * Every editable column is resubmitted whole, including the recurrence terms.
 * Which of them changed is decided in SQL by `public.replace_bill`, not here —
 * it is the layer that already holds the stored row, and a client-computed
 * "did the terms change" answer would decide whether the future schedule is
 * rebuilt.
 */
export const billUpdateSchema = z
  .object({ id: zUuid, ...billFields })
  .transform(toBillInput);

/**
 * Archive/unarchive. The same string-literal comparison as
 * `accountArchiveSchema` and `goalArchiveSchema`, for the same reason:
 * `Boolean("false")` is `true`, and a coercion bug here would silently invert
 * an archive.
 *
 * Separate from the edit schema on purpose — mixing archive state into an edit
 * would let a save change it as a side effect of an unrelated field, and
 * archiving is the one bill operation with no form fields at all.
 */
export const billArchiveSchema = z.object({
  id: zUuid,
  archived: z
    .string({ error: "Select a state." })
    .refine((value) => value === "true" || value === "false", { error: "Select a state." })
    .transform((value) => value === "true"),
});
