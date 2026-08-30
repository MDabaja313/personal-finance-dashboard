"use client";

import { useActionState, useId } from "react";

import { OccurrenceStatusBadge } from "@/components/bills/occurrence-status-badge";
import type { BillOccurrenceRow } from "@/components/bills/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";

/**
 * One bill's occurrence history — scheduled, paid and skipped alike, newest
 * due date first.
 *
 * ## Every amount here is the occurrence's own
 *
 * `occurrence.amountCents` was copied from the bill at generation time and is
 * what *that* instance was due for (docs/database-schema.md §13). It is never
 * read from the parent bill, which is the entire reason the column exists:
 * repricing a bill must not retroactively restate what was already paid. A
 * history row that fell back to the card's headline figure would silently undo
 * that guarantee in the one place a person goes to check it.
 *
 * ## The controls, and the one that is deliberately missing
 *
 * A paid row gets "Unmark paid"; a skipped row gets "Unskip". Both are the
 * same transition back to `scheduled`, and both clear the paid date and the
 * transaction link — the transaction itself is left exactly as it was.
 *
 * There is **no Delete control on any occurrence**, and there is no action
 * behind one either: `authenticated` holds no DELETE grant on
 * `bill_occurrences` at all, and `guard_bill_occurrence_delete()` refuses a
 * paid or skipped row regardless. History is corrected by changing its status,
 * never by removing it.
 *
 * A scheduled row's Paid/Skip controls live on the card above rather than
 * here, because those act on the *next* obligation and belong beside it.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

export function OccurrenceHistory({
  occurrences,
  restoreAction,
  interactive,
}: {
  occurrences: readonly BillOccurrenceRow[];
  restoreAction: FormAction;
  /**
   * False for an archived bill: its history stays fully visible, but a bill
   * nobody is tracking gets no status controls. Unarchive first.
   */
  interactive: boolean;
}) {
  if (occurrences.length === 0) {
    return <p className="text-sm text-muted-foreground">No occurrences yet.</p>;
  }

  return (
    <ul className="flex flex-col">
      {occurrences.map((occurrence, index) => (
        <li key={occurrence.id}>
          {index > 0 && <Separator className="my-2" />}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-foreground">
                {formatCalendarDate(occurrence.dueDate)} ·{" "}
                <span className="font-medium">{formatCents(occurrence.amountCents)}</span>
              </p>
              {occurrence.paidOn !== undefined && (
                <p className="text-xs text-muted-foreground">
                  Paid {formatCalendarDate(occurrence.paidOn)}
                </p>
              )}
              {occurrence.transactionLabel !== undefined && (
                <p className="truncate text-xs text-muted-foreground">
                  Linked to {occurrence.transactionLabel}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <OccurrenceStatusBadge status={occurrence.status} />
              {interactive && occurrence.status !== "scheduled" && (
                <RestoreControl
                  action={restoreAction}
                  occurrenceId={occurrence.id}
                  label={occurrence.status === "paid" ? "Unmark paid" : "Unskip"}
                />
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RestoreControl({
  action,
  occurrenceId,
  label,
}: {
  action: FormAction;
  occurrenceId: string;
  label: string;
}) {
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
          {pending ? "Saving…" : label}
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
