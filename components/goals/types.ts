import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate, Cents } from "@/lib/types";

/**
 * The goal Server Actions, bundled so `/goals` can hand them down through
 * `GoalCard` → `GoalCardActions` as one prop.
 *
 * A type-only import of `lib/actions/types`, which is the only way
 * `components/**` may reach that layer — the actions themselves arrive as
 * values from `app/**`.
 */
export interface GoalMutationActions {
  readonly update: FormAction;
  readonly setArchived: FormAction;
  readonly contribute: FormAction;
}

/**
 * One contribution, for display in a goal's history. A local shape rather
 * than an import of `lib/data/goals.ts`'s `GoalContribution` DTO —
 * `components/**` may not import `lib/data/**` at all, even at the type
 * level (unlike `lib/actions/**`, which has an explicit `import type`
 * exemption). Built from `lib/types` primitives only, which is legal
 * everywhere.
 */
export interface GoalContributionRow {
  readonly id: string;
  readonly amountCents: Cents;
  readonly occurredOn: CalendarDate;
  readonly note?: string;
}
