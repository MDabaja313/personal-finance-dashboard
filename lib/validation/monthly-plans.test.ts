import { describe, expect, it } from "vitest";

import { makeMonthlyPlanSchema } from "@/lib/validation/monthly-plans";

const PLAN_ID = "00000000-0000-4000-8000-000000000001";
const PERIOD = "2026-08";

describe("makeMonthlyPlanSchema", () => {
  const schema = makeMonthlyPlanSchema(PERIOD);

  it("parses a submission key and a money string into cents", () => {
    expect(schema.parse({ id: PLAN_ID, expectedIncome: "4000.00" })).toEqual({
      id: PLAN_ID,
      period: PERIOD,
      expectedIncomeCents: 400_000,
    });
  });

  it("injects the period rather than reading one from the submission", () => {
    // The application only ever manages the owner's current month, and the
    // Server Action derives it from `getToday()`. A hand-crafted request naming
    // another month has nothing this schema will accept.
    const parsed = schema.parse({ id: PLAN_ID, expectedIncome: "1.00", period: "2001-01" });
    expect(parsed.period).toBe(PERIOD);
  });

  it("accepts zero — 'no income expected' is a real plan", () => {
    expect(schema.parse({ id: PLAN_ID, expectedIncome: "0" }).expectedIncomeCents).toBe(0);
  });

  it("rejects a negative figure — an expectation has no direction", () => {
    expect(schema.safeParse({ id: PLAN_ID, expectedIncome: "-100.00" }).success).toBe(false);
  });

  it("rejects more than two decimal places rather than rounding them away", () => {
    expect(schema.safeParse({ id: PLAN_ID, expectedIncome: "1234.567" }).success).toBe(false);
  });

  it("rejects exponent notation and other non-amounts", () => {
    for (const expectedIncome of ["1e5", "abc", "", "  "]) {
      expect(schema.safeParse({ id: PLAN_ID, expectedIncome }).success).toBe(false);
    }
  });

  it("accepts thousands commas and a currency symbol, as every money field here does", () => {
    expect(schema.parse({ id: PLAN_ID, expectedIncome: "$4,000.50" }).expectedIncomeCents).toBe(
      400_050
    );
  });

  it("requires a submission key", () => {
    expect(schema.safeParse({ expectedIncome: "100.00" }).success).toBe(false);
    expect(schema.safeParse({ id: "not-a-uuid", expectedIncome: "100.00" }).success).toBe(false);
  });

  it("accepts no owner id, no account, no category and no date", () => {
    // A plan is a month and a figure. Anything else posted alongside it is
    // dropped rather than stored — there is no ledger field on this row for a
    // caller to reach.
    const parsed = schema.parse({
      id: PLAN_ID,
      expectedIncome: "100.00",
      userId: PLAN_ID,
      accountId: PLAN_ID,
      categoryId: PLAN_ID,
      date: "2026-08-01",
      actualIncome: "999.00",
    });

    expect(Object.keys(parsed).sort()).toEqual(["expectedIncomeCents", "id", "period"]);
  });
});
