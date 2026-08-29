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
  /**
   * Reconcile this account's balance to an observed figure (Phase 7 CP5).
   *
   * On the account surface rather than the transaction surface deliberately:
   * the question is "what is this account's balance really?", which is asked
   * of an account and answered by looking at one. The adjustment row it
   * produces shows up in `/transactions` like any other row, and is removed
   * from there.
   */
  readonly reconcile: FormAction;
}
