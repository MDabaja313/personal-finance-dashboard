import { attempt } from "@/lib/actions/result";
import type { ActionState, SubmittedValues } from "@/lib/actions/types";
import { getToday } from "@/lib/data/clock";

/**
 * The owner's calendar day, resolved for a Server Action — or the `ActionState`
 * to return instead.
 *
 * Every dated write needs this, and every one of them must handle its failure
 * identically, so it lives in one place rather than once per action file. It is
 * deliberately *not* a Server Action itself (no `"use server"`): it is an
 * internal helper the action modules import, and marking it would publish an
 * endpoint for something that is not one.
 *
 * ## Why `today` is fetched at all
 *
 * A transaction or a movement has a date, and "not in the future" has to mean
 * the future where the *person* is — an owner in Auckland entering today's
 * transfer would be refused for several hours a day against a UTC ceiling.
 * `getToday()` derives the date from `profiles.timezone`, which is the same
 * source `assert_transaction_refs()` reads, so a form's message and the
 * database's refusal can never disagree.
 *
 * ## Why its own failures are handled here
 *
 * `getToday()` is a database read behind a verified `getOwnerId()`, so it can
 * fail exactly as any other read can: an ended session, a missing profile row,
 * an unreachable database. It is therefore run through `attempt()` like a
 * mutation, and its outcome branched on identically. What it must never do is
 * throw past the action layer into the error boundary: a form that vanishes
 * into a full-page error because a timezone lookup blipped is strictly worse
 * than one that says "try again".
 *
 * ## Why it returns the redirect decision instead of redirecting
 *
 * `redirect()` signals by throwing, and `attempt()` catches everything — so
 * navigation stays at the top level of the action, where its control flow is
 * visible at the call site. This helper reports *that* a redirect is warranted;
 * the action performs it.
 */
export type TodayOutcome =
  | { readonly ok: true; readonly today: string }
  | {
      readonly ok: false;
      readonly state: ActionState;
      readonly redirectToLogin: boolean;
    };

export async function resolveToday(values?: SubmittedValues): Promise<TodayOutcome> {
  const outcome = await attempt(() => getToday(), values);
  if (outcome.ok) return { ok: true, today: outcome.value };
  return {
    ok: false,
    state: outcome.state,
    redirectToLogin: outcome.reason === "unauthenticated",
  };
}
