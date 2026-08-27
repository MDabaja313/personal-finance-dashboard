/**
 * The shape a form Server Action returns, and nothing else.
 *
 * Deliberately free of `server-only`, of Supabase, and of every runtime value
 * — exactly like `lib/auth/types.ts`, and for the same reason: a form is a
 * Client Component and needs this shape at the type level to call
 * `useActionState`. A type-only import carries no runtime access, so a
 * component may import from here while still being fenced out of value
 * imports from `lib/actions/**` (eslint.config.mjs, `lib/write-posture.test.ts`).
 *
 * ## What may never appear on an ActionState
 *
 * An `ActionState` crosses the network to the browser. It therefore carries
 * only what a person is allowed to read: a generic message, per-field
 * messages, and — optionally — the strings the person themselves just typed,
 * so the form can be repopulated. It never carries an `AppError`, a `cause`,
 * a raw driver/PostgREST error, a database id the form did not already know,
 * a row, or any derived financial figure. `lib/actions/result.ts` is the only
 * sanctioned way to build one, which is what makes that rule enforceable
 * rather than aspirational.
 */

/**
 * `idle` is the pre-submission state — no attempt has been made yet, so it is
 * distinct from a `success` with nothing to say. Keeping the three apart is
 * what lets a form render "" before submission, a confirmation after one, and
 * an error without ever having to infer which happened from empty strings.
 */
export type ActionStatus = "idle" | "success" | "error";

/**
 * Per-field messages, keyed by the form control's `name`.
 *
 * Plural per field because one value can fail several rules at once, and a
 * form that shows only the first makes the person fix the same input twice.
 */
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

/**
 * The submitted values, echoed back so a rejected form is not blanked.
 *
 * `string` only, and that is a security boundary, not a convenience: a
 * `FormData` entry is `string | File`, and money is `Cents`. Nothing typed,
 * numeric, or binary belongs here — only the raw text the person entered, for
 * fields the action explicitly chose to echo.
 */
export type SubmittedValues = Readonly<Record<string, string>>;

export interface ActionState {
  readonly status: ActionStatus;
  /** A whole-form message. `null` whenever there is nothing to say. */
  readonly formError: string | null;
  /** Empty object when no field failed — never `undefined`, so a form can index it freely. */
  readonly fieldErrors: FieldErrors;
  /** Absent unless the action chose to echo the submission back. */
  readonly values?: SubmittedValues;
}

/**
 * Why an attempt failed, in terms the action layer can branch on.
 *
 * This is a *classification*, not a message: it exists so a Server Action can
 * decide what to do (redirect to `/login` on `unauthenticated`, re-render the
 * form otherwise) without inspecting an `AppError`, and without any helper
 * performing navigation on its behalf. The user-facing wording for each
 * reason lives in `lib/actions/result.ts` and is fixed — never assembled from
 * the underlying error.
 */
export type FailureReason =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_input"
  | "unavailable";

/**
 * The result of running a mutation through `attempt()`.
 *
 * On failure it carries both the classification (for the action's own control
 * flow) and a ready-to-return `ActionState` (for the form), so the action
 * never has to build an error state — or decide what is safe to say — itself.
 */
export type AttemptOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: FailureReason; readonly state: ActionState };

/** A form Server Action's signature, as `useActionState` sees it. */
export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;
