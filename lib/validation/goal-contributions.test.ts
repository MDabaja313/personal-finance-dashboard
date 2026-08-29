import { describe, expect, it } from "vitest";

import { makeGoalContributionCreateSchema } from "@/lib/validation/goal-contributions";

const VALID_ID = "00000000-0000-4000-8000-000000000001";
const VALID_GOAL = "00000000-0000-4000-8000-000000000002";
const TODAY = "2026-08-20";

describe("makeGoalContributionCreateSchema", () => {
  it("derives a positive amount for 'add'", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    const parsed = schema.parse({
      id: VALID_ID,
      goalId: VALID_GOAL,
      action: "add",
      amount: "100.00",
      occurredOn: TODAY,
      note: "",
    });

    expect(parsed.amountCents).toBe(10000);
  });

  it("derives a negative amount for 'withdraw'", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    const parsed = schema.parse({
      id: VALID_ID,
      goalId: VALID_GOAL,
      action: "withdraw",
      amount: "40.00",
      occurredOn: TODAY,
      note: "correction",
    });

    expect(parsed.amountCents).toBe(-4000);
    expect(parsed.note).toBe("correction");
  });

  it("keeps a zero amount exactly zero regardless of action", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    expect(
      schema.parse({ id: VALID_ID, goalId: VALID_GOAL, action: "add", amount: "0", occurredOn: TODAY })
        .amountCents
    ).toBe(0);
    expect(
      schema.parse({
        id: VALID_ID,
        goalId: VALID_GOAL,
        action: "withdraw",
        amount: "0",
        occurredOn: TODAY,
      }).amountCents
    ).toBe(0);
  });

  it("rejects a negative amount — the field is a magnitude, never a sign", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    expect(
      schema.safeParse({
        id: VALID_ID,
        goalId: VALID_GOAL,
        action: "add",
        amount: "-5",
        occurredOn: TODAY,
      }).success
    ).toBe(false);
  });

  it("rejects an unknown action", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    expect(
      schema.safeParse({
        id: VALID_ID,
        goalId: VALID_GOAL,
        action: "deposit",
        amount: "10",
        occurredOn: TODAY,
      }).success
    ).toBe(false);
  });

  it("rejects a date later than the factory's today", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    expect(
      schema.safeParse({
        id: VALID_ID,
        goalId: VALID_GOAL,
        action: "add",
        amount: "10",
        occurredOn: "2026-08-21",
      }).success
    ).toBe(false);
  });

  it("accepts today itself", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    expect(
      schema.safeParse({
        id: VALID_ID,
        goalId: VALID_GOAL,
        action: "add",
        amount: "10",
        occurredOn: TODAY,
      }).success
    ).toBe(true);
  });

  it("leaves note undefined when blank", () => {
    const schema = makeGoalContributionCreateSchema(TODAY);
    const parsed = schema.parse({
      id: VALID_ID,
      goalId: VALID_GOAL,
      action: "add",
      amount: "10",
      occurredOn: TODAY,
      note: "   ",
    });
    expect(parsed.note).toBeUndefined();
  });
});
