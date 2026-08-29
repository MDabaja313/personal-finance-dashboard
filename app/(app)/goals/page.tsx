import { Target } from "lucide-react";
import { AddGoal } from "@/components/goals/add-goal";
import { GoalCard } from "@/components/goals/goal-card";
import type { GoalContributionRow } from "@/components/goals/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { createGoalContributionAction } from "@/lib/actions/goal-contributions";
import { createGoalAction, setGoalArchivedAction, updateGoalAction } from "@/lib/actions/goals";
import { getGoalContributions, getGoalsForManagement } from "@/lib/data/goals";
import { getToday } from "@/lib/data/clock";
import { goalProgress } from "@/lib/finance/goals";

/**
 * Phase 7 CP6: `/goals` becomes the goal management surface — active goals
 * with Edit/Contribute/History/Archive, and a separate Archived section with
 * Unarchive. The Server Actions are imported here, in `app/**`, and handed
 * to the client components as props.
 *
 * Contribution history is fetched eagerly, one query per goal, rather than
 * on demand: every other read in this application is resolved at
 * render time and passed down as props (there is no client-side data
 * fetching anywhere in this codebase), and a personal owner's goal count is
 * small enough that this stays cheap.
 */
export default async function GoalsPage() {
  const [goals, today] = await Promise.all([getGoalsForManagement(), getToday()]);

  const contributionsByGoal = new Map<string, GoalContributionRow[]>(
    await Promise.all(
      goals.map(
        async (goal): Promise<[string, GoalContributionRow[]]> => [
          goal.id,
          await getGoalContributions(goal.id),
        ]
      )
    )
  );

  const active = goals.filter((g) => !g.isArchived);
  const archived = goals.filter((g) => g.isArchived);

  const actions = {
    update: updateGoalAction,
    setArchived: setGoalArchivedAction,
    contribute: createGoalContributionAction,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Goals" description="Progress toward your savings goals." />

      <AddGoal action={createGoalAction} />

      {goals.length === 0 ? (
        <EmptyState title="No goals yet" icon={Target} />
      ) : (
        <>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active goals.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((goal) => (
                <GoalCard
                  key={goal.id}
                  progress={goalProgress(goal, today)}
                  actions={actions}
                  today={today}
                  contributions={contributionsByGoal.get(goal.id) ?? []}
                />
              ))}
            </div>
          )}

          {archived.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Archived</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {archived.map((goal) => (
                  <GoalCard
                    key={goal.id}
                    progress={goalProgress(goal, today)}
                    isArchived
                    actions={actions}
                    today={today}
                    contributions={contributionsByGoal.get(goal.id) ?? []}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
