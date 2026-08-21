import { toCents, type Bill } from "@/lib/types";

/**
 * Due dates relative to MOCK_TODAY = 2026-08-20: one overdue, two due within
 * 7 days, two further out (upcoming).
 */
export const mockBills: readonly Bill[] = Object.freeze([
  { id: "bill-electric", name: "Electric Bill", amountCents: toCents(14500), dueDate: "2026-08-18", frequency: "monthly", categoryId: "cat-utilities", accountId: "acc-checking" }, // overdue
  { id: "bill-streaming", name: "Streaming Subscription", amountCents: toCents(1599), dueDate: "2026-08-22", frequency: "monthly", categoryId: "cat-subscriptions", accountId: "acc-credit" }, // due soon
  { id: "bill-internet", name: "Internet Bill", amountCents: toCents(7999), dueDate: "2026-08-23", frequency: "monthly", categoryId: "cat-utilities", accountId: "acc-checking" }, // due soon
  { id: "bill-gym", name: "Gym Membership", amountCents: toCents(4000), dueDate: "2026-09-01", frequency: "monthly", categoryId: "cat-subscriptions", accountId: "acc-checking" }, // upcoming
  { id: "bill-insurance", name: "Car Insurance", amountCents: toCents(61200), dueDate: "2026-09-05", frequency: "yearly", categoryId: "cat-insurance", accountId: "acc-checking" }, // upcoming
]);
