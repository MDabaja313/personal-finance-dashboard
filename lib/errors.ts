/**
 * Typed thrown errors for lib/data/**. Not a Result<T, E> — pages already
 * rely on Next.js error boundaries, so a caught-and-returned error type
 * would just be unwrapped back into a throw at the call site.
 *
 * A Server Component error reaches the client as a generic message plus a
 * `digest` hash only (custom properties, including `code`, are stripped in
 * production) — so `code` is for server-side branching only (translating to
 * `notFound()`, a login redirect, etc.), never for client-side UI branching.
 * Phase 7 adds two write-side codes — `conflict` (a unique constraint
 * rejected an otherwise well-formed row) and `invalid_input` (the database
 * refused a value: FK, CHECK, or a class-22 data exception). They exist so a
 * Server Action can tell "try a different value" apart from "try again later"
 * without reading a driver error; `lib/actions/result.ts` is what turns the
 * code into a message a person sees.
 *
 * Never put balances, amounts, merchant names, row payloads, or raw
 * driver/database errors in the `message` — dev *does* forward `message` to
 * the client. Pass the original error as `cause` instead, which stays
 * server-side.
 */
export type AppErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_input"
  | "data_integrity"
  | "unavailable";

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "AppError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function unauthorized(message = "Not authenticated.", options?: { cause?: unknown }): AppError {
  return new AppError("unauthorized", message, options);
}

export function forbidden(message = "Not permitted.", options?: { cause?: unknown }): AppError {
  return new AppError("forbidden", message, options);
}

export function notFound(message = "Resource not found.", options?: { cause?: unknown }): AppError {
  return new AppError("not_found", message, options);
}

/**
 * A write lost a race with the database's own rules — a unique constraint
 * (SQLSTATE 23505) rejected the row. Distinct from `invalid_input`: the input
 * was well-formed, it just collides with data that already exists, so the
 * remedy is a different value rather than a corrected one.
 *
 * The colliding value is never in the message. A constraint name identifies
 * the column, and PostgREST's own text quotes the offending value outright —
 * both stay in `cause`.
 */
export function conflict(message = "That change conflicts with existing data.", options?: { cause?: unknown }): AppError {
  return new AppError("conflict", message, options);
}

/**
 * Untrusted input the database refused — a foreign key that names no owned
 * row (23503), a CHECK the value violates (23514), or a value the column's
 * type cannot represent (class 22).
 *
 * This is the *last* line of input defense, not the first: `lib/validation/**`
 * rejects malformed input long before a query is issued. Reaching this code
 * means either a hand-crafted request to a Server Action endpoint or a
 * validation gap — so the message stays generic and names neither the column,
 * the constraint, nor the value.
 */
export function invalidInput(message = "That information is not valid.", options?: { cause?: unknown }): AppError {
  return new AppError("invalid_input", message, options);
}

export function dataIntegrity(message = "Data integrity check failed.", options?: { cause?: unknown }): AppError {
  return new AppError("data_integrity", message, options);
}

export function unavailable(message = "Service unavailable.", options?: { cause?: unknown }): AppError {
  return new AppError("unavailable", message, options);
}
