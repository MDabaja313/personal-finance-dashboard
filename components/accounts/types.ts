import type { FormAction } from "@/lib/actions/types";

/**
 * The account Server Actions, bundled so the route can hand them down through
 * `AccountGroup` → `AccountCard` → `AccountCardActions` as one prop instead of
 * three.
 *
 * A type-only import of `lib/actions/types`, which is the only way
 * `components/**` may reach that layer: the actions themselves arrive as
 * values from `app/**`, never through an import here (eslint.config.mjs,
 * `lib/write-posture.test.ts`).
 */
export interface AccountMutationActions {
  readonly update: FormAction;
  readonly setArchived: FormAction;
}
