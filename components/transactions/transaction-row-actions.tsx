"use client";

import { useActionState, useId, useState } from "react";

import { MovementRowActions } from "@/components/movements/movement-row-actions";
import type {
  MovementAccountOption,
  MovementMutationActions,
} from "@/components/movements/types";
import { TransactionSheet } from "@/components/transactions/transaction-sheet";
import type {
  AccountOption,
  AdjustmentMutationActions,
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
 * The per-row controls, for whichever kind of row this is.
 *
 * Exactly one of four things renders, and they are mutually exclusive by
 * construction rather than by ordering luck:
 *
 * - **A movement's source leg** gets the movement controls, which act on the
 *   *parent*: editing replaces both legs atomically under the movement's
 *   original id, deleting removes the parent and cascades both legs. The page
 *   attaches `row.movement` to that one leg and to nothing else, so a pair
 *   never grows two sets of buttons.
 * - **An ordinary income/expense/refund row** gets the transaction controls.
 * - **An `adjustment`** gets a Remove control and *no* Edit control. That
 *   asymmetry is the reconciliation model, not an omission: an adjustment
 *   records the correction a stated balance implied, so there is no coherent
 *   "edit the amount" — the way to change it is to remove it and reconcile
 *   again, which is why CP3 left adjustment DELETE possible while making
 *   adjustment UPDATE impossible in both directions.
 * - **Everything else** — a movement's destination leg — gets nothing at all
 *   rather than disabled buttons, because a disabled button invites the
 *   question "why?" without answering it. It is not hidden from *history*: it
 *   still renders, with its amount, date and badge, exactly as before.
 *
 * The database enforces every one of these exclusions independently of
 * anything here: `transactions_update_own_ordinary` makes a movement leg or an
 * adjustment invisible to UPDATE, `transactions_delete_own_non_movement` makes
 * a leg invisible to DELETE, and `lib/data/mutations/reconciliation.ts` refuses
 * to delete anything that is not an owned, non-movement adjustment. Removing
 * this component would not open a path to any of them.
 */
export function TransactionRowActions({
  row,
  actions,
  movementActions,
  adjustmentActions,
  accounts,
  movementAccounts,
  categories,
  today,
  className,
}: {
  row: TransactionRow;
  actions: TransactionMutationActions;
  movementActions: MovementMutationActions;
  adjustmentActions: AdjustmentMutationActions;
  accounts: readonly AccountOption[];
  movementAccounts: readonly MovementAccountOption[];
  categories: readonly CategoryOption[];
  today: CalendarDate;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (row.movement === undefined && !row.editable && !row.removableAdjustment) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-1", className)}>
      {row.movement !== undefined ? (
        <MovementRowActions
          movement={row.movement}
          actions={movementActions}
          accounts={movementAccounts}
          today={today}
        />
      ) : row.removableAdjustment ? (
        <RemoveAdjustmentControl action={adjustmentActions.remove} row={row} />
      ) : (
        <>
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
        </>
      )}
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

/**
 * Remove one balance adjustment, behind a two-step confirmation that says what
 * removing it actually does.
 *
 * The wording is the point. Deleting an ordinary transaction removes a record
 * of something that happened; removing an adjustment *changes the account's
 * current balance back* — it un-does a reconciliation. A person who reconciled
 * to the wrong figure needs exactly this, and a person who thinks they are
 * tidying up history needs to be told that they are not.
 *
 * There is deliberately no Edit beside it. `transactions_update_own_ordinary`
 * carries `kind <> 'adjustment'` in both its `USING` and its `WITH CHECK`, so
 * an adjustment cannot be targeted by an UPDATE and an ordinary row cannot be
 * retyped into one — the supported correction is remove-and-reconcile-again,
 * from `/accounts`.
 *
 * A plain `<form>` posting to a Server Action, like every other write here. The
 * row disappears because the action revalidated `/transactions` and the server
 * re-rendered the list without it, so a refusal leaves the row exactly where it
 * was with the reason underneath.
 */
function RemoveAdjustmentControl({ action, row }: { action: FormAction; row: TransactionRow }) {
  const [state, formAction, pending] = useActionState(action, INITIAL_ACTION_STATE);
  const [confirming, setConfirming] = useState(false);
  const errorId = useId();

  const error = state.formError !== null && (
    <p id={errorId} role="alert" className="basis-full text-right text-xs text-destructive">
      {state.formError}
    </p>
  );

  if (!confirming) {
    return (
      <>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Remove
          <span className="sr-only"> adjustment of {row.date} on {row.accountName}</span>
        </Button>
        {error}
      </>
    );
  }

  return (
    <>
      <span className="text-xs text-muted-foreground">
        Remove? This changes the account&rsquo;s balance.
      </span>
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
          {pending ? "Removing…" : "Yes"}
          <span className="sr-only">, remove this adjustment and change the balance</span>
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
      {error}
    </>
  );
}
