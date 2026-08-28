import type { Category } from "@/lib/types";

/**
 * The default category set. All active — `is_archived` defaults to false in
 * `supabase/seed.sql`, so `isArchived: false` here is what the seeded rows
 * actually hold, not a placeholder. The parity oracle compares field for
 * field, so this must keep matching the database exactly.
 */
export const mockCategories: readonly Category[] = Object.freeze([
  { id: "cat-salary", name: "Salary", kind: "income", isArchived: false },
  { id: "cat-interest", name: "Interest", kind: "income", isArchived: false },
  { id: "cat-housing", name: "Housing", kind: "expense", isArchived: false },
  { id: "cat-groceries", name: "Groceries", kind: "expense", isArchived: false },
  { id: "cat-dining", name: "Dining", kind: "expense", isArchived: false },
  { id: "cat-transportation", name: "Transportation", kind: "expense", isArchived: false },
  { id: "cat-entertainment", name: "Entertainment", kind: "expense", isArchived: false },
  { id: "cat-shopping", name: "Shopping", kind: "expense", isArchived: false },
  { id: "cat-utilities", name: "Utilities", kind: "expense", isArchived: false },
  { id: "cat-healthcare", name: "Healthcare", kind: "expense", isArchived: false },
  { id: "cat-subscriptions", name: "Subscriptions", kind: "expense", isArchived: false },
  { id: "cat-insurance", name: "Insurance", kind: "expense", isArchived: false },
]);
