"use client";

import { useActionState, useId, useState } from "react";

import { MovementSheet } from "@/components/movements/movement-sheet";
import type {
  MovementAccountOption,
  MovementEditRow,
  MovementMutationActions,
} from "@/components/movements/types";
import { INITIAL_MOVEMENT_ACTION_STATE } from "@/components/movements/types";
import { Button } from "@/components/ui/button";
import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";

/**
 * The Edit and Delete controls for one movement.
 *
 * ## Rendered on exactly one of the two legs
 *
 * A transfer is two rows in the ledger and both stay fully visible in history —
 * each in its own account, which is the whole point of storing it as a pair.
 * But it is *one* thing to edit and one thing to delete, so exactly one row
 * carries the controls: the **source leg**, the negative one.
 *
 * The source leg is the canonical representative because "money left here" is
 * where a person looks for the movement they made, and because the choice is
 * deterministic rather than positional — `getMovements()` derives which leg is
 * the source from the legs' signs, and `validate_movement()` guarantees exactly
 * one of them is negative. The destination leg renders with no controls at all
 * rather than with disabled ones, exactly as an adjustment does: a disabled
 * button invites the question "why?" without answering it.
 *
 * The page decides this, not this component — it attaches a `movement` to the
 * source leg's row and to nothing else — so the rule has one definition rather
 * than a copy per view.
 *
 * ## Editing edits the pair
 *
 * There is no control here that touches a leg. Saving replaces the whole
 * movement atomically under its original id, and deleting removes the parent
 * so the cascade takes both legs. The database enforces the same split
 * independently: `transactions_update_own_ordinary` and
 * `transactions_delete_own_non_movement` both carry `movement_id IS NULL`, so
 * a leg is invisible to the ordinary statements regardless of what any
 * component renders.
 */
export function MovementRowActions({
  movement,
  actions,
  accounts,
  today,
}: {
  movement: MovementEditRow;
  actions: MovementMutationActions;
  accounts: readonly MovementAccountOption[];
  today: CalendarDate;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
        Edit
        <span className="sr-only"> {movement.label}</span>
      </Button>

      <DeleteControl action={actions.remove} movement={movement} />

      <MovementSheet
        open={editing}
        onOpenChange={setEditing}
        title="Edit movement"
        description="Both legs are rewritten together. If anything is refused, the movement is left exactly as it was."
        action={actions.update}
        accounts={accounts}
        today={today}
        movement={movement}
      />
    </>
  );
}

/**
 * Delete, behind a two-step confirmation — the same shape the ordinary row
 * uses, so the two surfaces behave identically where they overlap.
 *
 * Inline rather than a modal: it lives in a table cell, it has exactly one
 * question to ask, and a dialog would take focus away from the row being talked
 * about. The first press swaps the button for "Delete? Yes / No", so the
 * destructive action is never one stray click away.
 *
 * A plain `<form>` posting to a Server Action, with no optimistic removal. Both
 * rows disappear because the action revalidated `/transactions` and the server
 * re-rendered the list without them — which is also why a refusal leaves both
 * legs exactly where they were, with the reason underneath.
 */
function DeleteControl({
  action,
  movement,
}: {
  action: FormAction;
  movement: MovementEditRow;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_MOVEMENT_ACTION_STATE);
  const [confirming, setConfirming] = useState(false);
  const errorId = useId();

  if (!confirming) {
    return (
      <>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Delete
          <span className="sr-only"> {movement.label}</span>
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
      <span className="text-xs text-muted-foreground">Delete both legs?</span>
      <form action={formAction}>
        {/* The movement's own id. There is no action anywhere that takes a leg
            id — deleting the parent is the only correct way to remove a pair. */}
        <input type="hidden" name="id" value={movement.id} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive"
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Deleting…" : "Yes"}
          <span className="sr-only">, delete {movement.label}</span>
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
