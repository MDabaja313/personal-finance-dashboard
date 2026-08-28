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
