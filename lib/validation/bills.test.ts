import { describe, expect, it } from "vitest";

import { billArchiveSchema, billCreateSchema, billUpdateSchema } from "@/lib/validation/bills";

const VALID_ID = "00000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "00000000-0000-4000-8000-0000000000c1";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000a1";

const base = {
  id: VALID_ID,
  name: "Electric Bill",
  amount: "145.00",
  frequency: "monthly",
  anchorDate: "2026-03-18",
  categoryId: "",
  accountId: "",
};

describe("billCreateSchema", () => {
  it("parses every field, trimming the name and parsing money to cents", () => {
    const parsed = billCreateSchema.parse({
      ...base,
      name: "  Electric Bill  ",
      amount: "1,450.75",
      categoryId: CATEGORY_ID,
      accountId: ACCOUNT_ID,
    });

    expect(parsed).toEqual({
      id: VALID_ID,
      name: "Electric Bill",
      amountCents: 145075,
      frequency: "monthly",
      anchorDate: "2026-03-18",
      categoryId: CATEGORY_ID,
      accountId: ACCOUNT_ID,
    });
  });

  it("leaves an unselected category and account undefined rather than failing as bad UUIDs", () => {
    const parsed = billCreateSchema.parse(base);
    expect(parsed.categoryId).toBeUndefined();
    expect(parsed.accountId).toBeUndefined();
  });

  it("accepts every bill frequency", () => {
    for (const frequency of ["weekly", "biweekly", "monthly", "yearly"]) {
      expect(billCreateSchema.parse({ ...base, frequency }).frequency).toBe(frequency);
    }
  });

  it("rejects a frequency that is not a bill_frequency label", () => {
    expect(billCreateSchema.safeParse({ ...base, frequency: "daily" }).success).toBe(false);
    expect(billCreateSchema.safeParse({ ...base, frequency: "" }).success).toBe(false);
  });

  it("accepts an anchor date in the past — a late invoice is a real, overdue obligation", () => {
    expect(billCreateSchema.parse({ ...base, anchorDate: "2019-01-31" }).anchorDate).toBe(
      "2019-01-31"
    );
  });

  it("accepts an anchor date in the future — an arrangement that has not started yet", () => {
    expect(billCreateSchema.parse({ ...base, anchorDate: "2099-11-01" }).anchorDate).toBe(
      "2099-11-01"
    );
  });

  it("rejects a date that does not exist on the calendar", () => {
    expect(billCreateSchema.safeParse({ ...base, anchorDate: "2026-02-30" }).success).toBe(false);
    expect(billCreateSchema.safeParse({ ...base, anchorDate: "2026-13-01" }).success).toBe(false);
  });

  it("requires an anchor date", () => {
    expect(billCreateSchema.safeParse({ ...base, anchorDate: "" }).success).toBe(false);
  });

  it("rejects a blank or whitespace-only name", () => {
    expect(billCreateSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(billCreateSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });

  it("rejects a name longer than the input bound", () => {
    expect(billCreateSchema.safeParse({ ...base, name: "x".repeat(121) }).success).toBe(false);
  });

  it("rejects a negative amount — the form collects a magnitude, not a signed figure", () => {
    expect(billCreateSchema.safeParse({ ...base, amount: "-1.00" }).success).toBe(false);
  });

  it("accepts a zero amount — bills.amount_cents carries no CHECK constraint", () => {
    // Deliberately unlike goals (`> 0`) and budgets (`>= 0`): the approved
    // schema imposes no sign or magnitude rule on a bill at all, and CP7 does
    // not invent one. A tracked obligation whose amount is not yet known is a
    // real thing.
    expect(billCreateSchema.parse({ ...base, amount: "0" }).amountCents).toBe(0);
  });

  it("rejects a non-numeric amount", () => {
    expect(billCreateSchema.safeParse({ ...base, amount: "" }).success).toBe(false);
    expect(billCreateSchema.safeParse({ ...base, amount: "abc" }).success).toBe(false);
  });

  it("rejects a malformed idempotency key", () => {
    expect(billCreateSchema.safeParse({ ...base, id: "not-a-uuid" }).success).toBe(false);
  });

  it("accepts no owner id — there is no field for one", () => {
    const parsed = billCreateSchema.parse({ ...base, userId: "someone-else" });
    expect(parsed).not.toHaveProperty("userId");
  });
});

describe("billUpdateSchema", () => {
  it("parses the same shape as create — a bill keeps its id for life", () => {
    const parsed = billUpdateSchema.parse({ ...base, categoryId: CATEGORY_ID });
    expect(parsed.id).toBe(VALID_ID);
    expect(parsed.categoryId).toBe(CATEGORY_ID);
  });

  it("lets a previously-set category be cleared back to absent", () => {
    expect(billUpdateSchema.parse({ ...base, categoryId: "" }).categoryId).toBeUndefined();
  });

  it("carries no archive field — archiving is its own action", () => {
    const parsed = billUpdateSchema.parse({ ...base, archived: "true" });
    expect(parsed).not.toHaveProperty("archived");
    expect(parsed).not.toHaveProperty("isArchived");
  });
});

describe("billArchiveSchema", () => {
  it("compares the flag as a string literal, never by coercion", () => {
    // Boolean("false") is true; a coercion bug here would silently invert an
    // archive.
    expect(billArchiveSchema.parse({ id: VALID_ID, archived: "true" }).archived).toBe(true);
    expect(billArchiveSchema.parse({ id: VALID_ID, archived: "false" }).archived).toBe(false);
  });

  it("rejects anything that is not exactly 'true' or 'false'", () => {
    for (const archived of ["", "yes", "1", "TRUE"]) {
      expect(billArchiveSchema.safeParse({ id: VALID_ID, archived }).success).toBe(false);
    }
  });
});
