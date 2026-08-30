"use client";

import { useActionState, useEffect, useId, useState } from "react";

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
import type { CalendarDate } from "@/lib/types";
import { CONTRIBUTION_ACTIONS, type ContributionAction } from "@/lib/types/enums";

/**
 * "Add funds" / "Withdraw / correction" — log progress toward a goal without
 * anyone having to reason about signed cents.
 *
 * The amount field is always a non-negative magnitude; the action control
 * says which direction, and the server derives the stored sign
 * (`signedContributionAmountFor`, mirroring `signedAmountFor`'s pattern for
 * ordinary transactions). A withdrawal/correction does not delete or edit
 * any earlier row — `goal_contributions` is append-only — it simply adds a
 * new, negative one.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

const ACTION_LABEL: Record<ContributionAction, string> = {
  add: "Add funds",
  withdraw: "Withdraw / correction",
};

export function ContributionForm({
  action,
  goalId,
  today,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  goalId: string;
  /** The owner's calendar day — the date field's default and its ceiling. */
  today: CalendarDate;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [contributionAction, setContributionAction] = useState<ContributionAction>("add");

  // One key per mounted form — this component is only ever rendered while
  // its disclosure is open, so a remount always means a new logical
  // submission.
  const [submissionKey] = useState(() => crypto.randomUUID());

  const actionFieldId = useId();
  const amountId = useId();
  const dateId = useId();
  const noteId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess?.();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={submissionKey} />
      <input type="hidden" name="goalId" value={goalId} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={actionFieldId} className="text-sm font-medium text-foreground">
          Action
        </label>
        <Select
          name="action"
          value={contributionAction}
          onValueChange={(value) => setContributionAction(value as ContributionAction)}
          disabled={pending}
        >
          <SelectTrigger id={actionFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTRIBUTION_ACTIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {ACTION_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={amountId} className="text-sm font-medium text-foreground">
          Amount
        </label>
        <Input
          id={amountId}
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={submitted?.amount ?? ""}
          required
          disabled={pending}
          aria-invalid={errorsFor("amount").length > 0 || undefined}
          aria-describedby={errorsFor("amount").length > 0 ? `${amountId}-error` : undefined}
        />
        {errorsFor("amount").length > 0 && (
          <p id={`${amountId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("amount").join(" ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={dateId} className="text-sm font-medium text-foreground">
          Date
        </label>
        <Input
          id={dateId}
          name="occurredOn"
          type="date"
          max={today}
          defaultValue={submitted?.occurredOn ?? today}
          required
          disabled={pending}
          aria-invalid={errorsFor("occurredOn").length > 0 || undefined}
          aria-describedby={errorsFor("occurredOn").length > 0 ? `${dateId}-error` : undefined}
        />
        {errorsFor("occurredOn").length > 0 && (
          <p id={`${dateId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("occurredOn").join(" ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className="text-sm font-medium text-foreground">
          Note (optional)
        </label>
        <Input
          id={noteId}
          name="note"
          maxLength={500}
          defaultValue={submitted?.note ?? ""}
          disabled={pending}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Goal contributions track progress toward this goal. They do not move money between your
        bank accounts.
      </p>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save contribution"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
