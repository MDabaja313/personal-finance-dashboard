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
