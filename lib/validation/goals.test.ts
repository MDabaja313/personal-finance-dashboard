import { describe, expect, it } from "vitest";

import { goalArchiveSchema, goalCreateSchema, goalUpdateSchema } from "@/lib/validation/goals";

const VALID_ID = "00000000-0000-4000-8000-000000000001";

describe("goalCreateSchema", () => {
  it("parses a name, a positive target, and an optional target date", () => {
    const parsed = goalCreateSchema.parse({
      id: VALID_ID,
      name: "  Emergency fund  ",
      target: "5,000.00",
      targetDate: "2027-06-30",
    });

    expect(parsed).toEqual({
      id: VALID_ID,
      name: "Emergency fund",
      targetCents: 500000,
      targetDate: "2027-06-30",
    });
  });

  it("leaves the target date undefined when blank", () => {
    const parsed = goalCreateSchema.parse({
      id: VALID_ID,
      name: "No date goal",
      target: "100",
      targetDate: "",
    });

    expect(parsed.targetDate).toBeUndefined();
  });

  it("rejects a zero target — goals_target_positive_ck is a strict '>'", () => {
    expect(
      goalCreateSchema.safeParse({ id: VALID_ID, name: "x", target: "0", targetDate: "" }).success
    ).toBe(false);
  });

  it("rejects a negative target", () => {
    expect(
      goalCreateSchema.safeParse({ id: VALID_ID, name: "x", target: "-1", targetDate: "" }).success
    ).toBe(false);
  });

  it("accepts a target date in the past — no restriction beyond being real", () => {
    const parsed = goalCreateSchema.parse({
      id: VALID_ID,
      name: "x",
      target: "100",
      targetDate: "2020-01-01",
    });
    expect(parsed.targetDate).toBe("2020-01-01");
  });

  it("rejects a malformed target date", () => {
    expect(
      goalCreateSchema.safeParse({ id: VALID_ID, name: "x", target: "100", targetDate: "2020-13-40" })
        .success
    ).toBe(false);
  });
});

describe("goalUpdateSchema", () => {
  it("allows the target to be set below what might already be saved — no rule here forbids it", () => {
    const parsed = goalUpdateSchema.parse({
      id: VALID_ID,
      name: "Renamed",
      target: "1.00",
      targetDate: "",
    });
    expect(parsed.targetCents).toBe(100);
  });
});

describe("goalArchiveSchema", () => {
  it("compares against the literal strings, never coercing", () => {
    expect(goalArchiveSchema.parse({ id: VALID_ID, archived: "true" }).archived).toBe(true);
    expect(goalArchiveSchema.parse({ id: VALID_ID, archived: "false" }).archived).toBe(false);
    expect(goalArchiveSchema.safeParse({ id: VALID_ID, archived: "yes" }).success).toBe(false);
  });
});
