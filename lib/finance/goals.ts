import { percentage } from "@/lib/finance/money";
import { toCents, type CalendarDate, type Cents, type Goal } from "@/lib/types";

export interface GoalProgress {
  goal: Goal;
  remainingCents: Cents;
  /** Percentage of target saved. May exceed 100 when over-funded; null when target is 0. */
  progress: number | null;
  isComplete: boolean;
  /** Only set when the goal has a future targetDate and isn't complete yet. */
  requiredMonthlyContributionCents: Cents | null;
}

function monthsUntil(today: CalendarDate, target: CalendarDate): number {
  const [ty, tm] = today.split("-").map(Number);
  const [gy, gm] = target.split("-").map(Number);
  return gy * 12 + gm - (ty * 12 + tm);
}

/** `today` is always explicit — this module never reads the clock. */
export function goalProgress(goal: Goal, today: CalendarDate): GoalProgress {
  const remainingCents = toCents(goal.targetCents - goal.savedCents);
  const progress = percentage(goal.savedCents, goal.targetCents);
  const isComplete = goal.savedCents >= goal.targetCents;

  let requiredMonthlyContributionCents: Cents | null = null;
  if (goal.targetDate && !isComplete) {
    const monthsRemaining = Math.max(1, monthsUntil(today, goal.targetDate));
    requiredMonthlyContributionCents = toCents(Math.ceil(remainingCents / monthsRemaining));
  }

  return { goal, remainingCents, progress, isComplete, requiredMonthlyContributionCents };
}
