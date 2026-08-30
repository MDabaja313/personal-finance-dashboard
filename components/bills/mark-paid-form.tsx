"use client";

import { useActionState, useEffect, useId, useState } from "react";

import type { TransactionOption } from "@/components/bills/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { CalendarDate, Cents } from "@/lib/types";

/**
 * The "Mark paid" form for one scheduled occurrence.
 *
 * Two fields, and the second is optional in the strongest sense.
 *
 * **The paid date defaults to the owner's own today**, resolved on the server
 * from `profiles.timezone` and passed in — never `new Date()` in the browser,
 * which would be the *viewer's* timezone and could sit a day either side of
 * the ceiling `guard_bill_occurrence_transition()` actually enforces. The
 * input's `max` is the same value, so the browser refuses a future date before
 * the server has to.
 *
 * **The transaction link is optional and changes nothing about the
 * transaction.** The note under the picker says so in plain words, because
 * this is the one screen where someone could reasonably assume that marking a
 * bill paid records the spending. It does not: no transaction is created, no
 * balance moves, and a linked transaction keeps its own amount, category,
 * account and date. A bill's amount and its linked payment's amount are
 * allowed to differ — the bill is what was expected, the transaction is what
 * happened.
 *
 * The picker is bounded and pre-resolved on the server (a fixed number of the
 * most recent transactions, each labelled with its date, merchant, amount and
 * account). It never loads a lifetime ledger into a form, and it deliberately
 * does not pre-select anything by matching amounts — a coincidence of figures
 * is not evidence of payment.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

/** The sentinel for "no linked transaction" — an empty option value is not selectable. */
const NONE = "none";

export function MarkPaidForm({
  action,
  occurrenceId,
  dueDate,
  amountCents,
  today,
  transactions,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  occurrenceId: string;
  dueDate: CalendarDate;
  amountCents: Cents;
  /** The owner's calendar day, from `profiles.timezone` — never the browser's. */
  today: CalendarDate;
  transactions: readonly TransactionOption[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [transactionId, setTransactionId] = useState<string>(NONE);

  const paidOnId = useId();
  const transactionFieldId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={occurrenceId} />
      <input
        type="hidden"
        name="transactionId"
        value={transactionId === NONE ? "" : transactionId}
      />

      <p className="text-sm text-foreground">
        {formatCents(amountCents)} due {formatCalendarDate(dueDate)}
      </p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={paidOnId} className="text-sm font-medium text-foreground">
          Paid on
        </label>
        <Input
          id={paidOnId}
          name="paidOn"
          type="date"
          max={today}
          defaultValue={submitted?.paidOn ?? today}
          required
          disabled={pending}
          aria-invalid={errorsFor("paidOn").length > 0 || undefined}
          aria-describedby={errorsFor("paidOn").length > 0 ? `${paidOnId}-error` : undefined}
        />
        {errorsFor("paidOn").length > 0 && (
          <p id={`${paidOnId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("paidOn").join(" ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={transactionFieldId} className="text-sm font-medium text-foreground">
          Link a transaction (optional)
        </label>
        <Select value={transactionId} onValueChange={(value) => setTransactionId(String(value))} disabled={pending}>
          <SelectTrigger id={transactionFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No linked transaction</SelectItem>
            {transactions.map((transaction) => (
              <SelectItem key={transaction.id} value={transaction.id}>
                {transaction.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errorsFor("transactionId").length > 0 && (
          <p role="alert" className="text-xs text-destructive">
            {errorsFor("transactionId").join(" ")}
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Marking a bill paid records that the obligation was met. It does not record spending — no
        transaction is created and no account balance changes. Linking one of your existing
        transactions just points at the payment you already recorded; that transaction is not
        altered in any way.
      </p>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Mark paid"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
