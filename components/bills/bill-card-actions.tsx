"use client";

import { useActionState, useCallback, useId, useState } from "react";

import { BillForm } from "@/components/bills/bill-form";
import { MarkPaidForm } from "@/components/bills/mark-paid-form";
import { OccurrenceHistory } from "@/components/bills/occurrence-history";
import type {
  BillFormValues,
  BillMutationActions,
  BillOccurrenceRow,
  BillReferenceOption,
  GeneratedPaymentPreview,
  TransactionOption,
} from "@/components/bills/types";
import { Button } from "@/components/ui/button";
import type { ActionState, FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";

/**
 * The per-bill controls: Edit, Mark paid, Skip, History, and
 * Archive/Unarchive.
 *
 * Only one disclosure is open at a time — the same reasoning
 * `AccountCardActions` uses for Edit versus Reconcile and `GoalCardActions`
 * generalizes to four panels.
 *
 * ## What an archived bill gets, and what it does not
 *
 * History and Unarchive, and nothing else. Editing an archived bill is refused
 * by `public.replace_bill` because its schedule cannot be regenerated while
 * archived — the terms and the occurrences would disagree until some later
 * unarchive — so the control is replaced by a sentence rather than rendered
 * and disabled. Mark paid and Skip are absent for the same reason: a bill
 * nobody is tracking has no next obligation to act on.
 *
 * ## Mark paid and Skip act on the *next scheduled* occurrence only
 *
 * They are rendered beside the due date they refer to, and only when there is
 * one. A bill whose occurrences are all paid or skipped, or whose horizon has
 * not been generated yet, gets neither — there is nothing for them to target,
 * and a control that acts on a row nobody can see is worse than no control.
 * Correcting an *older* occurrence happens in History, where the row is
 * visible.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

type OpenPanel = "none" | "edit" | "paid" | "history";

export function BillCardActions({
  bill,
  isArchived,
  nextOccurrence,
  occurrences,
  categories,
  accounts,
  transactions,
  generatedPayment,
  today,
  actions,
}: {
  bill: BillFormValues;
  isArchived: boolean;
  /** The earliest scheduled occurrence, when one exists. */
  nextOccurrence?: BillOccurrenceRow;
  occurrences: readonly BillOccurrenceRow[];
  categories: readonly BillReferenceOption[];
  accounts: readonly BillReferenceOption[];
  transactions: readonly TransactionOption[];
  /** What Mark paid will create when nothing is linked. Absent = status only. */
  generatedPayment?: GeneratedPaymentPreview;
  today: CalendarDate;
  actions: BillMutationActions;
}) {
  const [panel, setPanel] = useState<OpenPanel>("none");
  const close = useCallback(() => setPanel("none"), []);

  if (panel === "edit") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <BillForm
          action={actions.update}
          bill={bill}
          categories={categories}
          accounts={accounts}
          onSuccess={close}
          onCancel={close}
        />
      </div>
    );
  }

  if (panel === "paid" && nextOccurrence !== undefined) {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <MarkPaidForm
          action={actions.markPaid}
          occurrenceId={nextOccurrence.id}
          dueDate={nextOccurrence.dueDate}
          amountCents={nextOccurrence.amountCents}
          today={today}
          transactions={transactions}
          generatedPayment={generatedPayment}
          onSuccess={close}
          onCancel={close}
        />
      </div>
    );
  }

  if (panel === "history") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <OccurrenceHistory
          occurrences={occurrences}
          restoreAction={actions.restore}
          interactive={!isArchived}
        />
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={close}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {!isArchived && (
        <Button type="button" variant="outline" size="sm" onClick={() => setPanel("edit")}>
          Edit
          <span className="sr-only"> {bill.name}</span>
        </Button>
      )}

      {!isArchived && nextOccurrence !== undefined && (
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => setPanel("paid")}>
            Mark paid
          </Button>
          <SkipControl action={actions.skip} occurrenceId={nextOccurrence.id} />
        </>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={() => setPanel("history")}>
        History
      </Button>

      <ArchiveToggle action={actions.setArchived} billId={bill.id} isArchived={isArchived} />

      {isArchived && (
        <p className="basis-full text-xs text-muted-foreground">
          Archived. Unarchive it to edit it or track its next due date again.
        </p>
      )}
    </div>
  );
}

/**
 * Skip is a single submit rather than a two-step confirmation, deliberately.
 * Unlike the Delete controls elsewhere in this application it destroys
 * nothing: the occurrence keeps its due date and its amount, only its status
 * moves, and "Unskip" in History puts it straight back.
 */
function SkipControl({ action, occurrenceId }: { action: FormAction; occurrenceId: string }) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const errorId = useId();

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="id" value={occurrenceId} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Saving…" : "Skip"}
        </Button>
      </form>

      {state.formError !== null && (
        <p id={errorId} role="alert" className="basis-full text-xs text-destructive">
          {state.formError}
        </p>
      )}
    </>
  );
}

function ArchiveToggle({
  action,
  billId,
  isArchived,
}: {
  action: FormAction;
  billId: string;
  isArchived: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const errorId = useId();

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="id" value={billId} />
        <input type="hidden" name="archived" value={isArchived ? "false" : "true"} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Saving…" : isArchived ? "Unarchive" : "Archive"}
        </Button>
      </form>

      {state.formError !== null && (
        <p id={errorId} role="alert" className="basis-full text-xs text-destructive">
          {state.formError}
        </p>
      )}
    </>
  );
}
