/**
 * Database/PostgREST error → `AppError` translation.
 *
 * Pure and client-free: it reads a plain error shape, so it is unit testable
 * offline and callable from every DAL function as
 * `if (error) throw mapDbError(error, "accounts")` — before touching `data`,
 * never optional-chaining past a failed query.
 *
 * ## What must never happen
 *
 * A raw Supabase error is never rethrown and never quoted. `error.message`,
 * `.details`, `.hint`, and `.code` stay out of the `AppError` message —
 * PostgREST messages routinely embed constraint names, column values, and
 * fragments of the offending row, and dev forwards `message` to the client.
 * The whole original object travels as `cause`, which stays server-side. That
 * is what keeps `app/(app)/error.tsx`'s generic + `digest` presentation honest.
 *
 * ## Why not switch on `code` alone
 *
 * PostgREST surfaces some failures as a Postgres SQLSTATE (`42501`), some as
 * its own `PGRST***` code, and some — a gateway timeout, a dropped
 * connection — with neither. Reading `status` as well means an auth or
 * privilege failure that arrives without a recognized code still lands in the
 * right bucket instead of being flattened into `unavailable`.
 *
 * The split follows PostgREST's documented HTTP semantics rather than the
 * intuition that anything auth-shaped is a 401: only the JWT codes
 * (PGRST301/302/303) and a literal 401 are authentication failures; SQLSTATE
 * class 28 and `42501` are documented as 403 and map to `forbidden`.
 */
import {
  AppError,
  conflict,
  forbidden,
  invalidInput,
  isAppError,
  unauthorized,
  unavailable,
} from "@/lib/errors";

/** The fields worth reading off an unknown error, however it was produced. */
interface ErrorSignals {
  code?: string;
  status?: number;
}

function readSignals(error: unknown): ErrorSignals {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;

  const code = typeof record.code === "string" ? record.code : undefined;

  // `status` on a PostgrestError/AuthError; `statusCode` on some transport
  // errors. A numeric string is accepted because HTTP status has arrived as
  // text from more than one layer of this stack historically.
  const rawStatus = record.status ?? record.statusCode;
  let status: number | undefined;
  if (typeof rawStatus === "number" && Number.isInteger(rawStatus)) {
    status = rawStatus;
  } else if (typeof rawStatus === "string" && /^\d+$/.test(rawStatus)) {
    status = Number(rawStatus);
  }

  return { code, status };
}

/**
 * Translates a failed Supabase/PostgREST response into the `lib/errors.ts`
 * taxonomy.
 *
 * `operation` is a short developer-authored noun for what was being read
 * ("accounts", "the owner profile") — never user input, never row data. It
 * exists so a server log line distinguishes which read failed.
 *
 * An `AppError` passes through untouched: a `data_integrity` raised by a
 * mapper is already correctly classified and must not be re-wrapped as
 * `unavailable` on its way out.
 */
export function mapDbError(error: unknown, operation: string): AppError {
  if (isAppError(error)) return error;

  const signals = readSignals(error);

  // The auth/privilege branches — 42501, Postgres class 28, PostgREST's JWT
  // codes, and a bare 401/403 — live in mapAuthFailure() below, shared with
  // mapWriteError() so a read and a write cannot classify the same failure
  // differently. The rationale for each branch is documented there.
  const authFailure = mapAuthFailure(signals, operation, "read", error);
  if (authFailure) return authFailure;

  // PGRST116 ("no rows returned" from a `.single()`) is deliberately not
  // mapped here: whether a missing row is a data-integrity failure or a
  // legitimately empty result depends on the relation, so the calling DAL
  // function decides.
  return unavailable(`Failed to load ${operation}.`, { cause: error });
}

/**
 * The identity/privilege half of the taxonomy, shared by the read and write
 * mappers.
 *
 * Deliberately factored out rather than duplicated: an auth or privilege
 * failure must classify identically whether it interrupted a SELECT or an
 * INSERT. Only the *wording* differs ("read" vs "modify"), which is why the
 * verb is a parameter and the decision is not.
 *
 * Returns `undefined` when the error is not auth-shaped, leaving the caller to
 * apply its own operation-specific rules.
 */
function mapAuthFailure(
  { code, status }: ErrorSignals,
  operation: string,
  verb: "read" | "modify",
  error: unknown
): AppError | undefined {
  // Postgres: insufficient_privilege. Under Phase 7 this is the code an
  // INSERT/UPDATE/DELETE raises while the table still has no write GRANT for
  // `authenticated` — which is exactly the CP1 state, proven in
  // supabase/tests/database/100-write-grants.sql.
  if (code === "42501") return forbidden(`Not permitted to ${verb} ${operation}.`, { cause: error });

  // Postgres class 28 — invalid_authorization_specification (28000) and
  // invalid_password (28P01). PostgREST documents this class as HTTP 403, not
  // 401: the request's identity was established and then rejected at the
  // database's authorization layer, which is a privilege failure rather than
  // a missing/expired credential.
  if (code?.startsWith("28")) return forbidden(`Not permitted to ${verb} ${operation}.`, { cause: error });

  // PostgREST's own JWT codes are the actual authentication failures:
  // PGRST301 (JWT expired/invalid), PGRST302 (anonymous request to an
  // endpoint requiring authentication), PGRST303 (JWT secret/verification
  // problem).
  if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303") {
    return unauthorized("Not authenticated.", { cause: error });
  }

  // No recognized code — fall back to transport status, so an auth or
  // privilege failure that arrives without one still lands in the right
  // bucket instead of being flattened into `unavailable`.
  if (status === 401) return unauthorized("Not authenticated.", { cause: error });
  if (status === 403) return forbidden(`Not permitted to ${verb} ${operation}.`, { cause: error });

  return undefined;
}

/**
 * The write-side counterpart of `mapDbError`, for INSERT/UPDATE/DELETE.
 *
 * Same non-leakage contract, unconditionally: no `message`, `details`,
 * `hint`, constraint name, column name, or offending value is ever quoted —
 * and a write error's payload is the *worst* one to quote, since PostgREST
 * embeds the failing row ("Failing row contains (…, -8420, …)"). The whole
 * original object travels as `cause`, server-side only.
 *
 * The extra codes over the read mapper are the ones only a write can raise:
 *
 * - **23505** unique_violation → `conflict`. The input was well-formed; it
 *   collides with a row that already exists (a duplicate category name, a
 *   second budget for the same category and period). The remedy is a
 *   different value, not a corrected one — which is why it is not
 *   `invalid_input`.
 * - **23503** foreign_key_violation and **23514** check_violation →
 *   `invalid_input`. A FK that names no owned row and a CHECK the value fails
 *   are both "this input is not acceptable", and 23503 is *also* how the
 *   composite-FK ownership design surfaces an attempt to reference another
 *   user's row, so it must never read as a server fault.
 * - **class 22** (data exception: 22P02 invalid_text_representation, 22003
 *   numeric_value_out_of_range, 22007 invalid_datetime_format, …) →
 *   `invalid_input`. A value the column's type cannot represent at all.
 *
 * 23514 is deliberately *not* `data_integrity`. That code means data already
 * in the database contradicts an invariant; a rejected write means the
 * database successfully defended one, which is the opposite outcome.
 *
 * Every one of these is a last line of defense, not the first:
 * `lib/validation/**` rejects malformed input before a query is built, and a
 * verified `getOwnerId()` scopes the row before RLS is consulted. Reaching
 * this function means a hand-crafted request, a race, or a validation gap.
 */
export function mapWriteError(error: unknown, operation: string): AppError {
  if (isAppError(error)) return error;

  const signals = readSignals(error);
  const authFailure = mapAuthFailure(signals, operation, "modify", error);
  if (authFailure) return authFailure;

  const { code } = signals;

  if (code === "23505") return conflict(`Conflicts with existing ${operation}.`, { cause: error });

  if (code === "23503" || code === "23514" || code?.startsWith("22")) {
    return invalidInput(`Invalid input for ${operation}.`, { cause: error });
  }

  return unavailable(`Failed to save ${operation}.`, { cause: error });
}
