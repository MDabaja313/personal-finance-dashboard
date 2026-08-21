import { Target } from "lucide-react";
import { GoalCard } from "@/components/goals/goal-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getGoals } from "@/lib/data/goals";
import { getToday } from "@/lib/data/clock";
import { goalProgress } from "@/lib/finance/goals";

export default async function GoalsPage() {
  const [goals, today] = await Promise.all([getGoals(), getToday()]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Goals" description="Progress toward your savings goals." />

      {goals.length === 0 ? (
        <EmptyState title="No goals yet" icon={Target} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((goal) => (
            <GoalCard key={goal.id} progress={goalProgress(goal, today)} />
          ))}
        </div>
      )}
    </div>
  );
}
