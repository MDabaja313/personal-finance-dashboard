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
import { AppError, forbidden, isAppError, unauthorized, unavailable } from "@/lib/errors";

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

  const { code, status } = readSignals(error);

  // Postgres: insufficient_privilege. Reached when a role lacks the GRANT for
  // the relation at all — e.g. `authenticated` attempting to SELECT
  // `movements`. Distinct from RLS filtering, which returns zero rows rather
  // than erroring.
  if (code === "42501") {
    return forbidden(`Not permitted to read ${operation}.`, { cause: error });
  }

  // Postgres class 28 — invalid_authorization_specification (28000) and
  // invalid_password (28P01). PostgREST documents this class as HTTP 403, not
  // 401: the request's identity was established and then rejected at the
  // database's authorization layer, which is a privilege failure rather than
  // a missing/expired credential.
  if (code?.startsWith("28")) {
    return forbidden(`Not permitted to read ${operation}.`, { cause: error });
  }

  // PostgREST's own JWT codes are the actual authentication failures:
  // PGRST301 (JWT expired/invalid), PGRST302 (anonymous request to an
  // endpoint requiring authentication), PGRST303 (JWT secret/verification
  // problem).
  if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303") {
    return unauthorized("Not authenticated.", { cause: error });
  }

  // No recognized code — fall back to transport status. PGRST116 ("no rows
  // returned" from a `.single()`) is deliberately not mapped here: whether a
  // missing row is a data-integrity failure or a legitimately empty result
  // depends on the relation, so the calling DAL function decides.
  if (status === 401) return unauthorized("Not authenticated.", { cause: error });
  if (status === 403) return forbidden(`Not permitted to read ${operation}.`, { cause: error });

  return unavailable(`Failed to load ${operation}.`, { cause: error });
}
