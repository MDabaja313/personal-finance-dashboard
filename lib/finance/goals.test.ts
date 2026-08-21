import { describe, expect, it } from "vitest";
import { toCents, type Goal } from "@/lib/types";
import { goalProgress } from "@/lib/finance/goals";

function goal(overrides: Partial<Goal>): Goal {
  return {
    id: "goal-1",
    name: "Test Goal",
    targetCents: toCents(100_000),
    savedCents: toCents(50_000),
    ...overrides,
  };
}

const today = "2026-08-20";

describe("goalProgress", () => {
  it("computes remaining and progress for a partially-funded goal", () => {
    const result = goalProgress(goal({ targetCents: toCents(100_000), savedCents: toCents(25_000) }), today);
    expect(result.remainingCents).toBe(75_000);
    expect(result.progress).toBe(25);
    expect(result.isComplete).toBe(false);
  });

  it("is complete when saved exactly equals target", () => {
    const result = goalProgress(goal({ targetCents: toCents(50_000), savedCents: toCents(50_000) }), today);
    expect(result.isComplete).toBe(true);
    expect(result.progress).toBe(100);
    expect(result.remainingCents).toBe(0);
    expect(result.requiredMonthlyContributionCents).toBeNull();
  });

  it("allows progress over 100% when over-funded, and is complete", () => {
    const result = goalProgress(goal({ targetCents: toCents(50_000), savedCents: toCents(60_000) }), today);
    expect(result.progress).toBe(120);
    expect(result.isComplete).toBe(true);
    expect(result.remainingCents).toBe(-10_000);
  });

  it("has null progress for a zero-target goal, and treats it as complete", () => {
    const result = goalProgress(goal({ targetCents: toCents(0), savedCents: toCents(0) }), today);
    expect(result.progress).toBeNull();
    expect(result.isComplete).toBe(true);
  });

  it("computes a required monthly contribution when a future target date exists", () => {
    const result = goalProgress(
      goal({ targetCents: toCents(120_000), savedCents: toCents(0), targetDate: "2026-12-20" }),
      today
    );
    // Aug -> Dec is 4 months; 120,000 / 4 = 30,000/month.
    expect(result.requiredMonthlyContributionCents).toBe(30_000);
  });

  it("clamps to at least 1 month when the target date has already passed", () => {
    const result = goalProgress(
      goal({ targetCents: toCents(10_000), savedCents: toCents(0), targetDate: "2026-01-01" }),
      today
    );
    expect(result.requiredMonthlyContributionCents).toBe(10_000);
  });
});
