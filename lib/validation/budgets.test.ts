import { describe, expect, it } from "vitest";

import { budgetDeleteSchema, budgetUpdateSchema, makeBudgetCreateSchema } from "@/lib/validation/budgets";

const VALID_ID = "00000000-0000-4000-8000-000000000001";
const VALID_CATEGORY = "00000000-0000-4000-8000-000000000002";

describe("makeBudgetCreateSchema", () => {
  it("injects the period from the factory argument, never from the input", () => {
    const schema = makeBudgetCreateSchema("2026-08");

    const parsed = schema.parse({ id: VALID_ID, categoryId: VALID_CATEGORY, limit: "500.00" });

    expect(parsed).toEqual({
      id: VALID_ID,
      categoryId: VALID_CATEGORY,
      period: "2026-08",
      limitCents: 50000,
    });
  });

  it("ignores a client-supplied period field entirely", () => {
    const schema = makeBudgetCreateSchema("2026-08");

    // Even if a hand-crafted request posted its own "period", the schema has
    // no field for it — the transform always injects the factory's value.
    const parsed = schema.parse({
      id: VALID_ID,
      categoryId: VALID_CATEGORY,
      limit: "10.00",
      period: "1999-01",
    });

    expect(parsed.period).toBe("2026-08");
  });

  it("accepts a zero limit — the database's own CHECK is >= 0, not > 0", () => {
    const schema = makeBudgetCreateSchema("2026-08");
    const parsed = schema.parse({ id: VALID_ID, categoryId: VALID_CATEGORY, limit: "0" });
    expect(parsed.limitCents).toBe(0);
  });

  it("rejects a negative limit", () => {
    const schema = makeBudgetCreateSchema("2026-08");
    expect(schema.safeParse({ id: VALID_ID, categoryId: VALID_CATEGORY, limit: "-1" }).success).toBe(
      false
    );
  });

  it("rejects a malformed id or category id", () => {
    const schema = makeBudgetCreateSchema("2026-08");
    expect(
      schema.safeParse({ id: "not-a-uuid", categoryId: VALID_CATEGORY, limit: "10" }).success
    ).toBe(false);
    expect(schema.safeParse({ id: VALID_ID, categoryId: "not-a-uuid", limit: "10" }).success).toBe(
      false
    );
  });
});

describe("budgetUpdateSchema", () => {
  it("carries only id and limit", () => {
    const parsed = budgetUpdateSchema.parse({ id: VALID_ID, limit: "1,234.56" });
    expect(parsed).toEqual({ id: VALID_ID, limitCents: 123456 });
  });

  it("rejects a negative limit", () => {
    expect(budgetUpdateSchema.safeParse({ id: VALID_ID, limit: "-5" }).success).toBe(false);
  });
});

describe("budgetDeleteSchema", () => {
  it("requires a valid id and nothing else", () => {
    expect(budgetDeleteSchema.parse({ id: VALID_ID })).toEqual({ id: VALID_ID });
    expect(budgetDeleteSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});
