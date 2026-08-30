/**
 * Pure constructors and classifiers for `ActionState`.
 *
 * Every function here is a total function of its arguments — no client, no
 * clock, no env, no `cookies()`, and (see below) no navigation. That is what
 * makes the whole write-result contract unit testable offline, and it is why
 * a Server Action can be reduced to: validate, `attempt()` the DAL call, then
 * decide what to do with the outcome.
 *
 * ## The three rules this module exists to enforce mechanically
 *
 * 1. **A user-facing message is chosen from a fixed table, never derived from
 *    the error.** `messageFor()` maps a classification to one of six constant
 *    sentences. An `AppError`'s own `message` — which may name a column, an
 *    operation, or a relation — is never read, and its `cause` (the raw
 *    PostgREST/driver object, complete with constraint names and fragments of
 *    the offending row) is never touched at all. A balance, an amount, a
 *    merchant, or a row therefore cannot reach the browser through an
 *    `ActionState`, regardless of what the DAL threw.
 * 2. **No helper here navigates.** No `redirect()`, no `notFound()`, no
 *    `revalidatePath()`. Navigation and cache invalidation are the Server
 *    Action's decisions and happen in the action, after `attempt()` returns.
 *    A helper that redirected would also be unreachable from a unit test and
 *    would make every caller's control flow invisible at its own call site.
 * 3. **No `NEXT_*` digest inspection.** Nothing here sniffs Next.js
 *    control-flow errors by digest string. Instead the contract is stricter
 *    and does not need to: `attempt()` wraps *data work only* (see its own
 *    docs), so a Next control-flow throw has no business being inside it in
 *    the first place. Digest sniffing is a private-API dependency that
 *    silently breaks on upgrade; a contract does not.
 */
import type {
  ActionState,
  AttemptOutcome,
  FailureReason,
  FieldErrors,
  SubmittedValues,
} from "@/lib/actions/types";
import { isAppError } from "@/lib/errors";

/**
 * The complete set of user-facing failure messages.
 *
 * Generic on purpose. These are shown after a *write* was refused, where the
 * cause is frequently something the person is not entitled to know about
 * (another owner's row, a privilege gap, a constraint name). Any extra
 * specificity a person can actually act on belongs in a field error produced
 * by validation, before the database is ever reached.
 */
const MESSAGES: Readonly<Record<FailureReason, string>> = Object.freeze({
  unauthenticated: "Your session has ended. Sign in again to continue.",
  forbidden: "You do not have permission to make that change.",
  not_found: "That item no longer exists.",
  conflict: "That conflicts with something that already exists.",
  invalid_input: "Some of the information entered is not valid.",
  unavailable: "Something went wrong. Please try again.",
});

const NO_FIELD_ERRORS: FieldErrors = Object.freeze({});

/** The message a person sees for a given failure classification. */
export function messageFor(reason: FailureReason): string {
  return MESSAGES[reason];
}

/**
 * The pre-submission state.
 *
 * A function rather than a shared exported constant, so no caller can hold a
 * reference that something else has reason to mutate; the returned object is
 * frozen regardless.
 */
export function idle(): ActionState {
  return Object.freeze({ status: "idle", formError: null, fieldErrors: NO_FIELD_ERRORS } as const);
}

/**
 * A completed write.
 *
 * Takes no payload by design: a successful mutation's result is read back
 * through the DAL on the next render, never smuggled to the client inside a
 * form state.
 */
export function succeeded(): ActionState {
  return Object.freeze({ status: "success", formError: null, fieldErrors: NO_FIELD_ERRORS } as const);
}

/** A whole-form failure with no field attribution. */
export function failed(formError: string, values?: SubmittedValues): ActionState {
  return Object.freeze({
    status: "error",
    formError,
    fieldErrors: NO_FIELD_ERRORS,
    ...(values ? { values: Object.freeze({ ...values }) } : {}),
  } as const);
}

/**
 * A validation failure, with per-field messages.
 *
 * The input shape — `Record<string, string[] | undefined>` — is exactly what
 * `z.flattenError(error).fieldErrors` produces, so a caller can hand that
 * straight over. It is typed structurally rather than as a Zod type on
 * purpose: this module stays free of any validation-library dependency, so
 * swapping or bypassing Zod never reaches the action-result layer.
 *
 * Empty and `undefined` entries are dropped, so `fieldErrors` never carries a
 * key that has nothing to say — a form would otherwise render an empty error
 * slot under a perfectly valid field.
 */
export function invalid(
  fieldErrors: Readonly<Record<string, readonly string[] | undefined>>,
  values?: SubmittedValues
): ActionState {
  const cleaned: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (messages && messages.length > 0) cleaned[field] = Object.freeze([...messages]);
  }

  return Object.freeze({
    status: "error",
    // A field-level failure still gets a form-level sentence: a person whose
    // one invalid field has scrolled out of view otherwise sees a form that
    // silently refuses to submit.
    formError: MESSAGES.invalid_input,
    fieldErrors: Object.freeze(cleaned),
    ...(values ? { values: Object.freeze({ ...values }) } : {}),
  } as const);
}

/**
 * Classifies any thrown value into a `FailureReason`.
 *
 * `AppError` codes map across one-to-one, with two deliberate collapses:
 *
 * - `data_integrity` → `unavailable`. It means data already in the database
 *   contradicts an invariant. That is a server fault rather than something
 *   the person did, and its message names columns — so it must read as "try
 *   again", never as "fix your input".
 * - Anything that is not an `AppError` → `unavailable`. An unrecognized throw
 *   is by definition not understood, and an unfamiliar error is exactly the
 *   kind that carries a stack, a query, or a row in its message. It is never
 *   given the benefit of the doubt.
 */
export function classify(error: unknown): FailureReason {
  if (!isAppError(error)) return "unavailable";

  switch (error.code) {
    case "unauthorized":
      return "unauthenticated";
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    case "conflict":
      return "conflict";
    case "invalid_input":
      return "invalid_input";
    case "data_integrity":
    case "unavailable":
      return "unavailable";
  }
}

/** The `ActionState` for a classified failure, using the fixed message table. */
export function failureState(reason: FailureReason, values?: SubmittedValues): ActionState {
  return failed(MESSAGES[reason], values);
}

/**
 * Runs one mutation and converts a throw into a safe, classified outcome.
 *
 * `run` must contain **data work only** — a `lib/data/mutations/**` call and
 * nothing else. It must not `redirect()`, `notFound()`, or `revalidatePath()`:
 * Next.js signals those by throwing, and this function catches everything, so
 * a control-flow throw inside `run` would be swallowed and reported to the
 * person as "something went wrong" while the navigation silently never
 * happened. This module refuses to paper over that by inspecting `NEXT_*`
 * digests (rule 3 above); instead the boundary is drawn so the situation
 * cannot arise, and `lib/data/mutations/**` is fenced away from
 * `next/navigation` and `next/cache` by ESLint precisely so the rule holds by
 * construction rather than by discipline. Do the navigating in the action,
 * after this returns.
 *
 * On failure the caller gets both halves: `reason`, to branch on — an
 * `unauthenticated` write is the one case a Server Action should turn into a
 * `redirect("/login")`, since a form cannot recover from an ended session —
 * and a ready `state` to return to the form for every other case.
 */
export async function attempt<T>(
  run: () => Promise<T>,
  values?: SubmittedValues
): Promise<AttemptOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const reason = classify(error);
    return { ok: false, reason, state: failureState(reason, values) };
  }
}

/**
 * The submitted text for an explicit allowlist of field names, ready to echo
 * back on `ActionState.values`.
 *
 * Allowlisted rather than "everything in the FormData", deliberately. A blind
 * copy would echo back whatever an arbitrary caller posted — including fields
 * the form never had, a `File`, or a credential — and `values` is the one
 * part of an `ActionState` sourced from untrusted input. Non-string entries
 * (`File`) and absent fields are dropped rather than coerced: `String(file)`
 * would produce "[object File]" and quietly pass a type check.
 *
 * Callers must not list a password or any other secret here; nothing echoed
 * back should be something a person would object to seeing re-rendered into
 * HTML.
 */
export function submittedValues(formData: FormData, fields: readonly string[]): SubmittedValues {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
  }
  return Object.freeze(values);
}
