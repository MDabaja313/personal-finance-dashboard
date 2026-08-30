"use client";

import { useActionState, useEffect, useId, useState } from "react";

import type { BudgetMutationActions } from "@/components/budgets/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { formatCentsForInput } from "@/lib/format/currency";
import type { Budget } from "@/lib/types";

/**
 * The per-budget controls: an inline "edit limit" disclosure and a two-step
 * Delete.
 *
 * Only the limit is ever editable in place — `budget.categoryId` and
 * `budget.period` are fixed for the life of the row
 * (`lib/validation/budgets.ts`), so there is no picker here at all, only an
 * amount field. Wrong category or wrong month means deleting this budget and
 * using `AddBudget` to create the right one.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

export function BudgetCardActions({
  budget,
  actions,
}: {
  budget: Budget;
  actions: BudgetMutationActions;
}) {
  const [editing, setEditing] = useState(false);
  const stopEditing = () => setEditing(false);

  if (editing) {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <EditLimitForm action={actions.update} budget={budget} onSuccess={stopEditing} onCancel={stopEditing} />
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
        Edit limit
      </Button>
      <DeleteControl action={actions.remove} budgetId={budget.id} />
    </div>
  );
}

function EditLimitForm({
  action,
  budget,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  budget: Budget;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const limitId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={budget.id} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={limitId} className="text-sm font-medium text-foreground">
          Monthly limit
        </label>
        <Input
          id={limitId}
          name="limit"
          inputMode="decimal"
          defaultValue={submitted?.limit ?? formatCentsForInput(budget.limitCents)}
          required
          disabled={pending}
          aria-invalid={errorsFor("limit").length > 0 || undefined}
          aria-describedby={errorsFor("limit").length > 0 ? `${limitId}-error` : undefined}
        />
        {errorsFor("limit").length > 0 && (
          <p id={`${limitId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("limit").join(" ")}
          </p>
        )}
      </div>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Delete, behind a two-step confirmation — the same pattern
 * `components/transactions/transaction-row-actions.tsx` uses. A budget is
 * planning metadata, not ledger history, so there is nothing further to say
 * in the confirmation beyond "are you sure".
 */
function DeleteControl({ action, budgetId }: { action: FormAction; budgetId: string }) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [confirming, setConfirming] = useState(false);
  const errorId = useId();

  const error = state.formError !== null && (
    <p id={errorId} role="alert" className="basis-full text-xs text-destructive">
      {state.formError}
    </p>
  );

  if (!confirming) {
    return (
      <>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Delete
        </Button>
        {error}
      </>
    );
  }

  return (
    <>
      <span className="text-xs text-muted-foreground">Delete this budget?</span>
      <form action={formAction}>
        <input type="hidden" name="id" value={budgetId} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive"
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Deleting…" : "Yes"}
        </Button>
      </form>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
        No
      </Button>
      {error}
    </>
  );
}
