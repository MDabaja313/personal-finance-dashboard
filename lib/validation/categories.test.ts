import { describe, expect, it } from "vitest";

import {
  categoryArchiveSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
} from "@/lib/validation/categories";

const ID = "22222222-2222-4222-8222-222222222222";

describe("categoryCreateSchema", () => {
  it("trims the name and narrows the kind", () => {
    expect(categoryCreateSchema.parse({ name: "  Groceries  ", kind: "expense" })).toEqual({
      name: "Groceries",
      kind: "expense",
    });
  });

  it("trims before storing, because uniqueness is on lower(name)", () => {
    // The database's unique index is on (user_id, lower(name)). An untrimmed
    // " Groceries" would slip past a collision with "Groceries" and produce two
    // categories a person cannot tell apart.
    expect(categoryCreateSchema.parse({ name: " Groceries", kind: "income" }).name).toBe(
      "Groceries"
    );
  });

  it("rejects a whitespace-only name", () => {
    expect(categoryCreateSchema.safeParse({ name: "   ", kind: "expense" }).success).toBe(false);
  });

  it("rejects a kind outside the category_kind enum", () => {
    // 'transfer' is a transaction kind, not a category kind — the two label
    // sets are deliberately different lists in lib/types/enums.ts.
    expect(categoryCreateSchema.safeParse({ name: "Groceries", kind: "transfer" }).success).toBe(
      false
    );
  });
});

describe("categoryUpdateSchema", () => {
  it("always carries the kind, changed or not", () => {
    // The mutation layer compares it against the stored value; a schema that
    // made it conditional would have to know whether the category is
    // referenced, which is a database read this layer must not perform.
    expect(categoryUpdateSchema.parse({ id: ID, name: "Food", kind: "expense" })).toEqual({
      id: ID,
      name: "Food",
      kind: "expense",
    });
  });

  it("rejects a malformed id", () => {
    expect(categoryUpdateSchema.safeParse({ id: "nope", name: "Food", kind: "expense" }).success).toBe(
      false
    );
  });
});

describe("categoryArchiveSchema", () => {
  it("reads the target state from the literal string", () => {
    expect(categoryArchiveSchema.parse({ id: ID, archived: "true" }).archived).toBe(true);
    expect(categoryArchiveSchema.parse({ id: ID, archived: "false" }).archived).toBe(false);
  });

  it("rejects anything that is not exactly 'true' or 'false'", () => {
    for (const archived of ["", "yes", "1", "TRUE"]) {
      expect(categoryArchiveSchema.safeParse({ id: ID, archived }).success, archived).toBe(false);
    }
  });
});
