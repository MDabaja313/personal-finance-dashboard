/**
 * The small pieces every mutation test file needs.
 *
 * Deliberately *not* a place where anything is faked. Each test file declares
 * its own `vi.mock()` calls at the top, so the complete list of what a file
 * pretends about stays visible in that file rather than hidden behind an
 * import — and the list is short by design: the Supabase seam
 * (`lib/data/supabase.ts`), plus `next/cache` and `next/navigation`.
 *
 * Those last two are mocked for a mechanical reason, not a behavioral one:
 * `revalidatePath()` and `redirect()` need a Next.js request store that does
 * not exist in a test process. Each file *records* the calls rather than
 * no-oping them, which turns that necessity into coverage — the suite asserts
 * which routes each action revalidates, which is otherwise only checkable by
 * reading the source.
 */
import type { ActionState } from "@/lib/actions/types";

/** The pre-submission state a `useActionState` form passes in. */
export const IDLE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

/**
 * Builds the `FormData` a browser would post.
 *
 * Every value is a string, exactly as an HTML form submits — including the
 * hidden `archived` flags, which the schemas compare against the literal
 * "true"/"false" rather than coercing.
 */
export function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

/** The routes an account write must invalidate, in the order the action lists them. */
export const ACCOUNT_ROUTES = ["/accounts", "/dashboard", "/analytics"];

/** The routes a category write must invalidate. */
export const CATEGORY_ROUTES = ["/transactions", "/budgets", "/dashboard", "/analytics"];

/**
 * The routes a transaction write must invalidate.
 *
 * Wider than either of the above, because a single ledger row moves an account
 * balance, a month's KPIs, a budget's utilisation, and four charts.
 */
export const TRANSACTION_ROUTES = [
  "/transactions",
  "/dashboard",
  "/accounts",
  "/budgets",
  "/analytics",
];

/**
 * The routes a movement write must invalidate.
 *
 * One narrower than a transaction write, and the omission is the point:
 * `/budgets` renders utilisation, which is `spendingByCategory` over rows
 * `countsAsSpending` admits — an allowlist of `expense` and `refund`. A
 * movement leg is excluded **by kind**, so no movement write can change any
 * figure that page renders. Listed as an exact array so adding `/budgets` out
 * of habit fails the assertion rather than passing quietly.
 */
export const MOVEMENT_ROUTES = ["/transactions", "/dashboard", "/accounts", "/analytics"];

/**
 * The calendar day `delta` days from `date`, as 'YYYY-MM-DD'.
 *
 * `Date.UTC` rather than local-midnight construction, for the same reason
 * `lib/finance/dates.ts` uses it: a local-time construction near a DST boundary
 * can shift the day. Used to build "the owner's tomorrow" from the owner's own
 * `getToday()`, which is the only date the posted-ledger ceiling can be tested
 * against without hardcoding a literal that ages.
 */
export function shiftCalendarDate(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}
