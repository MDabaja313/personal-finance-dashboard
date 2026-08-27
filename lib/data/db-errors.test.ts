import { describe, expect, it } from "vitest";

import { mapDbError, mapWriteError } from "@/lib/data/db-errors";
import { AppError, dataIntegrity, unauthorized } from "@/lib/errors";

/**
 * A PostgREST error carrying every field the library populates — deliberately
 * stuffed with the kind of content that must never reach a user-facing
 * message: a constraint name, a column name, and a real amount.
 */
const leakyPostgrestError = {
  code: "23514",
  message: 'new row for relation "transactions" violates check constraint "transactions_sign_by_kind_ck"',
  details: "Failing row contains (…, -8420, …).",
  hint: "Check the amount_cents sign for this kind.",
};

describe("mapDbError — taxonomy", () => {
  it("maps insufficient_privilege (42501) to forbidden", () => {
    const error = mapDbError({ code: "42501", message: "permission denied for table movements" }, "movements");

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("movements");
  });

  it("maps PostgREST's JWT codes to unauthorized", () => {
    // These are the actual authentication failures: PGRST301 (JWT
    // expired/invalid), PGRST302 (anonymous request to an endpoint requiring
    // authentication), PGRST303 (JWT secret/verification problem).
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      expect(mapDbError({ code, message: "JWT expired" }, "accounts").code).toBe("unauthorized");
    }
  });

  it("maps PGRST303 to unauthorized", () => {
    expect(mapDbError({ code: "PGRST303", message: "JWT secret is missing" }, "accounts").code).toBe(
      "unauthorized"
    );
  });

  it("maps Postgres class 28 (invalid authorization specification) to forbidden", () => {
    // PostgREST documents class 28 as HTTP 403, not 401 — the identity was
    // established and then rejected at the database's authorization layer.
    expect(mapDbError({ code: "28000", message: "invalid authorization" }, "accounts").code).toBe(
      "forbidden"
    );
    expect(mapDbError({ code: "28P01", message: "password authentication failed" }, "accounts").code).toBe(
      "forbidden"
    );
  });

  it("falls back to transport status when no code is recognized", () => {
    expect(mapDbError({ status: 401, message: "Unauthorized" }, "accounts").code).toBe("unauthorized");
    expect(mapDbError({ status: 403, message: "Forbidden" }, "accounts").code).toBe("forbidden");
    // Some layers of this stack surface status as text.
    expect(mapDbError({ statusCode: "403", message: "Forbidden" }, "accounts").code).toBe("forbidden");
  });

  it("maps a bare 401 to unauthorized and a bare 403 to forbidden", () => {
    const unauthenticated = mapDbError({ status: 401 }, "accounts");
    expect(unauthenticated.code).toBe("unauthorized");
    expect(unauthenticated.message).toBe("Not authenticated.");

    const notPermitted = mapDbError({ status: 403 }, "accounts");
    expect(notPermitted.code).toBe("forbidden");
    expect(notPermitted.message).toBe("Not permitted to read accounts.");
  });

  it("prefers a recognized code over a status that disagrees", () => {
    expect(mapDbError({ code: "42501", status: 401 }, "accounts").code).toBe("forbidden");
  });

  it("maps every other database, network, or PostgREST failure to unavailable", () => {
    const others: unknown[] = [
      leakyPostgrestError,
      { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      { status: 500, message: "Internal Server Error" },
      { status: 504, message: "Gateway Timeout" },
      new TypeError("fetch failed"),
      "a string that is not an error at all",
      null,
      undefined,
    ];

    for (const raw of others) {
      expect(mapDbError(raw, "accounts").code).toBe("unavailable");
    }
  });

  it("passes an AppError through untouched rather than re-wrapping it", () => {
    // A mapper's data_integrity is already correctly classified; flattening it
    // into `unavailable` on the way out would lose that.
    const original = dataIntegrity("Invalid cents value for transactions.amount_cents.");

    expect(mapDbError(original, "transactions")).toBe(original);

    const auth = unauthorized();
    expect(mapDbError(auth, "accounts")).toBe(auth);
  });
});

describe("mapDbError — non-leakage", () => {
  it("never quotes the raw message, details, hint, or code", () => {
    const error = mapDbError(leakyPostgrestError, "transactions");

    expect(error.message).not.toContain(leakyPostgrestError.message);
    expect(error.message).not.toContain(leakyPostgrestError.details);
    expect(error.message).not.toContain(leakyPostgrestError.hint);
    expect(error.message).not.toContain("transactions_sign_by_kind_ck");
    expect(error.message).not.toContain("23514");
    expect(error.message).not.toContain("8420");
  });

  it("keeps the user-facing message to a generic sentence naming only the operation", () => {
    expect(mapDbError(leakyPostgrestError, "transactions").message).toBe("Failed to load transactions.");
    expect(mapDbError({ code: "42501" }, "movements").message).toBe("Not permitted to read movements.");
    expect(mapDbError({ code: "PGRST301" }, "accounts").message).toBe("Not authenticated.");
    expect(
      mapDbError({ code: "28P01", message: 'password authentication failed for user "authenticated"' }, "goals")
        .message
    ).toBe("Not permitted to read goals.");
  });

  it("retains the original error as `cause`, which stays server-side", () => {
    for (const raw of [leakyPostgrestError, { code: "42501" }, { code: "PGRST301" }, { status: 500 }]) {
      expect(mapDbError(raw, "accounts").cause).toBe(raw);
    }
  });
});

/**
 * A write error carrying the worst possible payload: PostgREST embeds the
 * failing row itself on a constraint violation.
 */
const leakyWriteError = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "categories_user_id_lower_name_key"',
  details: "Key (user_id, lower(name))=(0e2f…, groceries) already exists.",
  hint: "Pick a different name.",
};

describe("mapWriteError — taxonomy", () => {
  it("maps unique_violation (23505) to conflict", () => {
    const error = mapWriteError(leakyWriteError, "categories");

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("conflict");
  });

  it("maps foreign_key_violation (23503) to invalid_input", () => {
    // Also how the composite-FK ownership design surfaces a reference to
    // another user's row — it must never read as a server fault.
    expect(mapWriteError({ code: "23503" }, "transactions").code).toBe("invalid_input");
  });

  it("maps check_violation (23514) to invalid_input, not data_integrity", () => {
    // data_integrity means stored data contradicts an invariant. A rejected
    // write means the database successfully defended one — the opposite.
    expect(mapWriteError({ code: "23514" }, "transactions").code).toBe("invalid_input");
  });

  it("maps Postgres class 22 (data exception) to invalid_input", () => {
    for (const code of ["22P02", "22003", "22007", "22001"]) {
      expect(mapWriteError({ code }, "budgets").code).toBe("invalid_input");
    }
  });

  it("preserves the existing auth and permission behavior", () => {
    expect(mapWriteError({ code: "42501" }, "accounts").code).toBe("forbidden");
    expect(mapWriteError({ code: "28000" }, "accounts").code).toBe("forbidden");
    expect(mapWriteError({ code: "28P01" }, "accounts").code).toBe("forbidden");
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      expect(mapWriteError({ code }, "accounts").code).toBe("unauthorized");
    }
    expect(mapWriteError({ status: 401 }, "accounts").code).toBe("unauthorized");
    expect(mapWriteError({ status: 403 }, "accounts").code).toBe("forbidden");
    expect(mapWriteError({ statusCode: "403" }, "accounts").code).toBe("forbidden");
  });

  it("classifies auth failures identically to the read mapper", () => {
    // Same failure, same classification, whether it interrupted a SELECT or
    // an INSERT — only the wording differs.
    for (const raw of [{ code: "42501" }, { code: "28P01" }, { code: "PGRST301" }, { status: 401 }]) {
      expect(mapWriteError(raw, "accounts").code).toBe(mapDbError(raw, "accounts").code);
    }
  });

  it("falls back to unavailable for an unrecognized failure", () => {
    expect(mapWriteError({ code: "08006" }, "accounts").code).toBe("unavailable");
    expect(mapWriteError({ status: 500 }, "accounts").code).toBe("unavailable");
    expect(mapWriteError(new Error("socket hang up"), "accounts").code).toBe("unavailable");
    expect(mapWriteError(null, "accounts").code).toBe("unavailable");
    expect(mapWriteError(undefined, "accounts").code).toBe("unavailable");
  });

  it("passes an AppError through untouched", () => {
    const original = dataIntegrity("Invalid cents value for accounts.opening_balance_cents.");
    expect(mapWriteError(original, "accounts")).toBe(original);
    expect(mapWriteError(unauthorized(), "accounts").code).toBe("unauthorized");
  });
});

describe("mapWriteError — non-leakage", () => {
  it("never quotes the raw message, details, hint, constraint, or code", () => {
    const error = mapWriteError(leakyWriteError, "categories");

    expect(error.message).not.toContain(leakyWriteError.message);
    expect(error.message).not.toContain(leakyWriteError.details);
    expect(error.message).not.toContain(leakyWriteError.hint);
    expect(error.message).not.toContain("categories_user_id_lower_name_key");
    expect(error.message).not.toContain("groceries");
    expect(error.message).not.toContain("23505");
  });

  it("keeps the user-facing message to a generic sentence naming only the operation", () => {
    expect(mapWriteError({ code: "23505" }, "categories").message).toBe(
      "Conflicts with existing categories."
    );
    expect(mapWriteError({ code: "23503" }, "transactions").message).toBe(
      "Invalid input for transactions."
    );
    expect(mapWriteError({ code: "42501" }, "accounts").message).toBe(
      "Not permitted to modify accounts."
    );
    expect(mapWriteError({ code: "PGRST301" }, "accounts").message).toBe("Not authenticated.");
    expect(mapWriteError({ status: 500 }, "budgets").message).toBe("Failed to save budgets.");
  });

  it("retains the original error as `cause`, which stays server-side", () => {
    for (const raw of [leakyWriteError, { code: "23503" }, { code: "42501" }, { status: 500 }]) {
      expect(mapWriteError(raw, "accounts").cause).toBe(raw);
    }
  });
});
