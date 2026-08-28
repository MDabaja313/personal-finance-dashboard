"use client";

import { useActionState, useId, useState } from "react";

import { TransactionSheet } from "@/components/transactions/transaction-sheet";
import type {
  AccountOption,
  CategoryOption,
  TransactionMutationActions,
  TransactionRow,
} from "@/components/transactions/types";
import { INITIAL_ACTION_STATE } from "@/components/transactions/types";
import { Button } from "@/components/ui/button";
import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The per-row Edit and Delete controls.
 *
 * Rendered only for rows the page marked `editable` — that is, ordinary
 * income/expense/refund rows. Movement legs and adjustments get no controls at
 * all rather than disabled ones, because a disabled button invites the question
 * "why?" without answering it, and both cases are explained where they are
 * decided (`TransactionRow.editable`). Neither is hidden from *history*: both
 * still render, with their amounts, dates and badges, exactly as before.
 *
 * The database enforces the same two exclusions independently of anything here:
 * `transactions_update_own_ordinary` makes a movement leg or an adjustment
 * invisible to UPDATE, and `transactions_delete_own_non_movement` makes a leg
 * invisible to DELETE. Removing this component would not open a path to either.
 */
export function TransactionRowActions({
  row,
  actions,
  accounts,
  categories,
  today,
  className,
}: {
  row: TransactionRow;
  actions: TransactionMutationActions;
  accounts: readonly AccountOption[];
  categories: readonly CategoryOption[];
  today: CalendarDate;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (!row.editable) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-1", className)}>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
        Edit
        <span className="sr-only"> {row.merchant}</span>
      </Button>

      <DeleteControl action={actions.remove} row={row} />

      <TransactionSheet
        open={editing}
        onOpenChange={setEditing}
        title="Edit transaction"
        description="Changes take effect on every balance and total that includes this row."
        action={actions.update}
        accounts={accounts}
        categories={categories}
        today={today}
        transaction={row}
      />
    </div>
  );
}

/**
 * Delete, behind a two-step confirmation.
 *
 * Inline rather than a modal: it lives in a table cell, it has exactly one
 * question to ask, and a dialog would take focus away from the row being talked
 * about. The first press swaps the button for "Delete? Yes / No", so the
 * destructive action is never one stray click away, and nothing is destroyed
 * until the second, explicit press.
 *
 * A plain `<form>` posting to a Server Action, like every other write in this
 * application — no client-side deletion and no optimistic removal. The row
 * disappears because the action revalidated `/transactions` and the server
 * re-rendered the list without it, which is also why a refusal (a bill
 * occurrence still points at this transaction) leaves the row exactly where it
 * was, with the reason underneath it.
 */
function DeleteControl({ action, row }: { action: FormAction; row: TransactionRow }) {
  const [state, formAction, pending] = useActionState(action, INITIAL_ACTION_STATE);
  const [confirming, setConfirming] = useState(false);
  const errorId = useId();

  if (!confirming) {
    return (
      <>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Delete
          <span className="sr-only"> {row.merchant}</span>
        </Button>
        {state.formError !== null && (
          <p id={errorId} role="alert" className="basis-full text-right text-xs text-destructive">
            {state.formError}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <span className="text-xs text-muted-foreground">Delete?</span>
      <form action={formAction}>
        <input type="hidden" name="id" value={row.id} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive"
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Deleting…" : "Yes"}
          <span className="sr-only">, delete {row.merchant}</span>
        </Button>
      </form>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(false)}
        disabled={pending}
      >
        No
      </Button>
      {state.formError !== null && (
        <p id={errorId} role="alert" className="basis-full text-right text-xs text-destructive">
          {state.formError}
        </p>
      )}
    </>
  );
}
