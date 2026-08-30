import type { FormAction } from "@/lib/actions/types";

/**
 * The budget Server Actions, bundled so the route can hand them down through
 * `/budgets` → `BudgetCard` → `BudgetCardActions` as one prop.
 *
 * A type-only import of `lib/actions/types`, which is the only way
 * `components/**` may reach that layer: the actions themselves arrive as
 * values from `app/**`, never through an import here.
 */
export interface BudgetMutationActions {
  readonly update: FormAction;
  readonly remove: FormAction;
}

/** One category eligible to be budgeted — an active expense category. */
export interface BudgetCategoryOption {
  readonly id: string;
  readonly name: string;
}

/**
 * The monthly-plan Server Actions, bundled so `/budgets` can hand them to the
 * summary card as one prop.
 *
 * Two, not three: setting and changing expected income are the same operation
 * (the mutation layer upserts by `(user_id, period)`), and clearing is the only
 * other thing a person can do to a plan. Neither takes a month — both derive it
 * from the owner's own calendar day on the server.
 */
export interface MonthlyPlanActions {
  readonly set: FormAction;
  readonly clear: FormAction;
}
