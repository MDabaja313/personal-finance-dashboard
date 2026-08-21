import type { Category } from "@/lib/types";

export const mockCategories: readonly Category[] = Object.freeze([
  { id: "cat-salary", name: "Salary", kind: "income" },
  { id: "cat-interest", name: "Interest", kind: "income" },
  { id: "cat-housing", name: "Housing", kind: "expense" },
  { id: "cat-groceries", name: "Groceries", kind: "expense" },
  { id: "cat-dining", name: "Dining", kind: "expense" },
  { id: "cat-transportation", name: "Transportation", kind: "expense" },
  { id: "cat-entertainment", name: "Entertainment", kind: "expense" },
  { id: "cat-shopping", name: "Shopping", kind: "expense" },
  { id: "cat-utilities", name: "Utilities", kind: "expense" },
  { id: "cat-healthcare", name: "Healthcare", kind: "expense" },
  { id: "cat-subscriptions", name: "Subscriptions", kind: "expense" },
  { id: "cat-insurance", name: "Insurance", kind: "expense" },
]);
