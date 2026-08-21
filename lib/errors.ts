/**
 * Typed thrown errors for lib/data/**. Not a Result<T, E> — pages already
 * rely on Next.js error boundaries, so a caught-and-returned error type
 * would just be unwrapped back into a throw at the call site.
 *
 * A Server Component error reaches the client as a generic message plus a
 * `digest` hash only (custom properties, including `code`, are stripped in
 * production) — so `code` is for server-side branching only (translating to
 * `notFound()`, a login redirect, etc.), never for client-side UI branching.
 * Never put balances, amounts, merchant names, row payloads, or raw
 * driver/database errors in the `message` — dev *does* forward `message` to
 * the client. Pass the original error as `cause` instead, which stays
 * server-side.
 */
export type AppErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
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

export function dataIntegrity(message = "Data integrity check failed.", options?: { cause?: unknown }): AppError {
  return new AppError("data_integrity", message, options);
}

export function unavailable(message = "Service unavailable.", options?: { cause?: unknown }): AppError {
  return new AppError("unavailable", message, options);
}
