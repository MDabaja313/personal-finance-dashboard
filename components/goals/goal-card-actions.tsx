"use client";

import { useActionState, useCallback, useId, useState } from "react";

import { ContributionForm } from "@/components/goals/contribution-form";
import { ContributionHistory } from "@/components/goals/contribution-history";
import { GoalForm } from "@/components/goals/goal-form";
import type { GoalContributionRow, GoalMutationActions } from "@/components/goals/types";
import { Button } from "@/components/ui/button";
import type { ActionState, FormAction } from "@/lib/actions/types";
import type { CalendarDate, Goal } from "@/lib/types";

/**
 * The per-goal controls: Edit, Add contribution, Contribution history, and
 * Archive/Unarchive.
 *
 * Only one disclosure is open at a time — the same reasoning
 * `AccountCardActions` uses for Edit versus Reconcile, generalized to four
 * panels instead of two. "Add contribution" is offered only while the goal
 * is active: `assert_goal_contribution_refs()` refuses one against an
 * archived goal regardless, and a control that always fails belongs behind
 * a sentence, not a button.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

type OpenPanel = "none" | "edit" | "contribute" | "history";

export function GoalCardActions({
  goal,
  isArchived,
  actions,
  today,
  contributions,
}: {
  goal: Goal;
  isArchived: boolean;
  actions: GoalMutationActions;
  today: CalendarDate;
  contributions: readonly GoalContributionRow[];
}) {
  const [panel, setPanel] = useState<OpenPanel>("none");
  const close = useCallback(() => setPanel("none"), []);

  if (panel === "edit") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <GoalForm action={actions.update} goal={goal} onSuccess={close} onCancel={close} />
      </div>
    );
  }

  if (panel === "contribute") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <ContributionForm
          action={actions.contribute}
          goalId={goal.id}
          today={today}
          onSuccess={close}
          onCancel={close}
        />
      </div>
    );
  }

  if (panel === "history") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <ContributionHistory contributions={contributions} />
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={close}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button type="button" variant="outline" size="sm" onClick={() => setPanel("edit")}>
        Edit
        <span className="sr-only"> {goal.name}</span>
      </Button>

      {!isArchived && (
        <Button type="button" variant="outline" size="sm" onClick={() => setPanel("contribute")}>
          Add contribution
        </Button>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={() => setPanel("history")}>
        History
      </Button>

      <ArchiveToggle action={actions.setArchived} goalId={goal.id} isArchived={isArchived} />
    </div>
  );
}

function ArchiveToggle({
  action,
  goalId,
  isArchived,
}: {
  action: FormAction;
  goalId: string;
  isArchived: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const errorId = useId();

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="id" value={goalId} />
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
