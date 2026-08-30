/**
 * Bill-occurrence status-change input → validated domain values.
 *
 * An occurrence has no editable *content*. Its amount and its due date were
 * fixed when it was generated (docs/database-schema.md §13) and neither the
 * owner nor the scheduler may rewrite them — the column-scoped UPDATE grant
 * names only `status`, `transaction_id` and `paid_on`, and
 * `guard_bill_occurrence_transition()` restates it at the row level. So these
 * schemas describe *transitions*, not a form over a row.
 *
 * Built from the CP1 primitives (`zUuid`, `zOptionalUuid`, `zNotFuture`).
 * Pure: Zod and `lib/types` only — no DAL, no clock, no env.
 *
 * **No owner id is accepted from the caller, ever.** The owner comes from
 * `getOwnerId()` inside the mutation DAL.
 *
 * **No `status` field is accepted either**, and that is the point of splitting
 * this into three schemas instead of one with a status selector. Each Server
 * Action performs exactly one named transition, so a well-formed submission
 * cannot ask for a transition the caller did not choose — the same reasoning
 * that keeps `signedAmountFor` deriving a sign from a kind rather than
 * accepting one. `guard_bill_occurrence_transition()` is the enforcement;
 * these are the shapes that never need to reach it.
 */
import { z } from "zod";

import type { CalendarDate } from "@/lib/types";
import { zNotFuture, zOptionalUuid, zUuid } from "@/lib/validation/primitives";

export interface BillOccurrencePaidInput {
  readonly id: string;
  readonly paidOn: CalendarDate;
  /** Present when the owner picked one of their own existing transactions to link. */
  readonly transactionId?: string;
  /**
   * The idempotency key the auto-created expense will take as its row `id`,
   * when one is created at all.
   *
   * Always minted by the form — one per mounted form, exactly as every other
   * create surface here does it — and required by the schema even on the
   * link-an-existing-transaction path, where it goes unused. Requiring it
   * unconditionally is what keeps the form from having to predict, in the
   * browser, whether the server will end up generating a row: that decision
   * depends on the bill's account and on whether it is archived, both of which
   * are the server's to know.
   */
  readonly generatedTransactionId: string;
}

/**
 * Mark one scheduled occurrence paid, parameterized by the owner's calendar
 * day.
 *
 * **`today` is a parameter, so this is a factory** — the same reason every
 * dated schema in this application takes one: the ceiling has to be the
 * owner's own calendar day (`getToday()`, from `profiles.timezone`), so the
 * form's message and `guard_bill_occurrence_transition()`'s refusal can never
 * disagree. A person cannot have paid something tomorrow.
 *
 * `paidOn` has no *floor*. Paying a bill weeks after it was due is the
 * ordinary case for an overdue occurrence, and paying one early is equally
 * real — `due_date` and `paidOn` are independent facts, and neither is
 * constrained against the other anywhere in this application.
 *
 * `transactionId` is optional, and supplying it is the owner saying "this
 * payment is already in my ledger, point at it". When it is present nothing
 * whatsoever about that transaction is altered — not its amount, category,
 * account or date — and nothing new is created. Its amount is free to differ
 * from the bill's: a bill is an expected obligation and a transaction is what
 * actually happened.
 *
 * No transaction *kind* is constrained here, deliberately. The approved design
 * imposes none — `bill_occurrences_transaction_fk` requires only that the row
 * belong to the same owner — and inventing one would refuse legitimate
 * records.
 *
 * ## What changed in Phase 8 CP1
 *
 * When `transactionId` is **absent**, marking paid is no longer guaranteed to
 * be status-only. If the bill names an account that is not archived,
 * `public.settle_bill_occurrence` creates one ordinary expense — the
 * occurrence's own amount, the bill's account, the bill's category when it can
 * legally label an expense, dated `paidOn`, merchant taken from the bill's name
 * — and records it as `generated`. When the bill names no usable account the
 * behaviour is exactly what it always was: paid, with no ledger row at all.
 *
 * None of that is decided here. This layer cannot read a bill, so it cannot
 * know which of the two will happen; it only carries the key the generated row
 * would take.
 */
export function makeBillOccurrencePaidSchema(today: CalendarDate) {
  return z
    .object({
      id: zUuid,
      paidOn: zNotFuture(today),
      transactionId: zOptionalUuid,
      generatedTransactionId: zUuid,
    })
    .transform(
      (value): BillOccurrencePaidInput => ({
        id: value.id,
        paidOn: value.paidOn,
        transactionId: value.transactionId,
        generatedTransactionId: value.generatedTransactionId,
      })
    );
}

/**
 * Skip one scheduled occurrence — "this obligation did not apply this cycle".
 *
 * One field, because there is nothing else to say: skipping records no date,
 * no amount and no payment, and it creates no financial activity of any kind.
 * The occurrence keeps its own due date and amount, so the history still shows
 * what was skipped and what it would have cost.
 */
export const billOccurrenceSkipSchema = z.object({ id: zUuid });

/**
 * Return one paid or skipped occurrence to `scheduled` — the correction path
 * for both "Unmark paid" and "Unskip".
 *
 * One schema for two labels, because it is one transition: the target state is
 * `scheduled` either way, and the mutation clears `paid_on` and
 * `transaction_id` in the same statement (they are the fields
 * `bill_occurrences_status_consistency_ck` forbids on a non-paid row). What
 * differs is only the word the button uses, which the UI picks from the
 * occurrence's current status.
 *
 * Clearing a link never touches the linked transaction. It stays exactly where
 * it was, with its own amount, category and account, and becomes deletable
 * again under its ordinary rules.
 */
export const billOccurrenceRestoreSchema = z.object({ id: zUuid });
