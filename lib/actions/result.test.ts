import { describe, expect, it } from "vitest";

import {
  attempt,
  classify,
  failed,
  failureState,
  idle,
  invalid,
  messageFor,
  submittedValues,
  succeeded,
} from "@/lib/actions/result";
import type { FailureReason } from "@/lib/actions/types";
import {
  AppError,
  conflict,
  dataIntegrity,
  forbidden,
  invalidInput,
  notFound,
  unauthorized,
  unavailable,
} from "@/lib/errors";

const ALL_REASONS: FailureReason[] = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "invalid_input",
  "unavailable",
];

/**
 * An error carrying exactly the content that must never reach the browser: a
 * balance, a merchant, a constraint name, and a raw driver error as `cause`.
 */
const leakyError = conflict("Conflicts with existing accounts.", {
  cause: {
    code: "23505",
    message: 'duplicate key value violates unique constraint "accounts_user_id_lower_name_key"',
    details: "Key (name)=(Chase Checking) already exists. Balance -842000.",
    hint: "Rename the account.",
  },
});

describe("state constructors", () => {
  it("idle() is the pre-submission state", () => {
    expect(idle()).toEqual({ status: "idle", formError: null, fieldErrors: {} });
  });

  it("succeeded() carries no payload", () => {
    // A mutation's result is read back through the DAL on the next render,
    // never smuggled to the client inside a form state.
    expect(succeeded()).toEqual({ status: "success", formError: null, fieldErrors: {} });
  });

  it("failed() sets a form-level message and no field errors", () => {
    expect(failed("Nope.")).toEqual({ status: "error", formError: "Nope.", fieldErrors: {} });
  });

  it("omits `values` entirely unless the caller echoes a submission", () => {
    expect("values" in failed("Nope.")).toBe(false);
    expect(failed("Nope.", { name: "Rent" }).values).toEqual({ name: "Rent" });
  });

  it("freezes what it returns, so a state cannot be mutated after the fact", () => {
    const state = failed("Nope.", { name: "Rent" });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.values)).toBe(true);
  });

  it("copies `values` rather than retaining the caller's object", () => {
    const values = { name: "Rent" };
    const state = failed("Nope.", values);
    values.name = "Mutated";
    expect(state.values).toEqual({ name: "Rent" });
  });
});

describe("invalid()", () => {
  it("keeps per-field messages and adds a form-level sentence", () => {
    // A person whose one invalid field has scrolled out of view otherwise
    // sees a form that silently refuses to submit.
    const state = invalid({ amount: ["Enter an amount."], date: ["That date is in the future."] });

    expect(state.status).toBe("error");
    expect(state.fieldErrors).toEqual({
      amount: ["Enter an amount."],
      date: ["That date is in the future."],
    });
    expect(state.formError).toBe(messageFor("invalid_input"));
  });

  it("keeps every message for a field that failed several rules", () => {
    const state = invalid({ name: ["Enter a name.", "Use 120 characters or fewer."] });
    expect(state.fieldErrors.name).toHaveLength(2);
  });

  it("drops empty and undefined entries", () => {
    // z.flattenError().fieldErrors can carry either; a form would otherwise
    // render an empty error slot under a perfectly valid field.
    const state = invalid({ amount: ["Enter an amount."], name: [], date: undefined });
    expect(Object.keys(state.fieldErrors)).toEqual(["amount"]);
  });

  it("accepts a flattened Zod fieldErrors object as-is", () => {
    // The structural shape is the contract — this layer never imports Zod.
    const flattened: Record<string, string[] | undefined> = { merchant: ["Enter a name."] };
    expect(invalid(flattened).fieldErrors).toEqual({ merchant: ["Enter a name."] });
  });

  it("echoes submitted values when given them", () => {
    const state = invalid({ amount: ["Enter an amount."] }, { amount: "12.345", merchant: "Rent" });
    expect(state.values).toEqual({ amount: "12.345", merchant: "Rent" });
  });
});

describe("classify()", () => {
  it("maps every AppError code", () => {
    expect(classify(unauthorized())).toBe("unauthenticated");
    expect(classify(forbidden())).toBe("forbidden");
    expect(classify(notFound())).toBe("not_found");
    expect(classify(conflict())).toBe("conflict");
    expect(classify(invalidInput())).toBe("invalid_input");
    expect(classify(unavailable())).toBe("unavailable");
  });

  it("collapses data_integrity to unavailable", () => {
    // Data already stored contradicts an invariant: a server fault, not
    // something the person did — and its message names columns.
    expect(classify(dataIntegrity("net_worth_snapshots row violates the identity."))).toBe(
      "unavailable"
    );
  });

  it("treats anything that is not an AppError as unavailable", () => {
    for (const thrown of [
      new Error("connection reset"),
      new TypeError("undefined is not a function"),
      "a string",
      null,
      undefined,
      { code: "unauthorized" },
      42,
    ]) {
      expect(classify(thrown)).toBe("unavailable");
    }
  });

  it("does not trust a look-alike error object", () => {
    // A duck-typed `{ code: "not_found" }` is not an AppError instance and
    // must not be classified as one.
    expect(classify({ code: "not_found", message: "x" })).toBe("unavailable");
  });
});

describe("messages", () => {
  it("has a non-empty message for every reason", () => {
    for (const reason of ALL_REASONS) {
      expect(messageFor(reason).length).toBeGreaterThan(0);
    }
  });

  it("never derives a message from the error's own text", () => {
    const state = failureState(classify(leakyError));

    expect(state.formError).toBe(messageFor("conflict"));
    expect(state.formError).not.toContain("accounts_user_id_lower_name_key");
    expect(state.formError).not.toContain("Chase Checking");
    expect(state.formError).not.toContain("842000");
    expect(state.formError).not.toContain("23505");
  });

  it("keeps unauthenticated wording free of any account-existence hint", () => {
    expect(messageFor("unauthenticated").toLowerCase()).not.toContain("password");
    expect(messageFor("unauthenticated").toLowerCase()).not.toContain("email");
  });
});

describe("attempt()", () => {
  it("returns the value on success", async () => {
    const outcome = await attempt(async () => "created-id");
    expect(outcome).toEqual({ ok: true, value: "created-id" });
  });

  it("classifies an unauthorized mutation error as unauthenticated", async () => {
    // The one case a Server Action should turn into redirect("/login") — a
    // form cannot recover from an ended session. attempt() classifies it and
    // does not navigate.
    const outcome = await attempt(async () => {
      throw unauthorized("Not authenticated.");
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("unauthenticated");
    expect(outcome.ok === false && outcome.state.formError).toBe(messageFor("unauthenticated"));
  });

  it("turns every other known error into a safe ActionState", async () => {
    const cases: Array<[AppError, FailureReason]> = [
      [forbidden("Not permitted to modify accounts."), "forbidden"],
      [notFound("Resource not found."), "not_found"],
      [conflict("Conflicts with existing categories."), "conflict"],
      [invalidInput("Invalid input for budgets."), "invalid_input"],
      [dataIntegrity("Invalid cents value for accounts.balance_cents."), "unavailable"],
    ];

    for (const [error, reason] of cases) {
      const outcome = await attempt(async () => {
        throw error;
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.reason).toBe(reason);
      expect(outcome.state.status).toBe("error");
      expect(outcome.state.formError).toBe(messageFor(reason));
      expect(outcome.state.fieldErrors).toEqual({});
    }
  });

  it("turns an unknown throw into the generic unavailable state", async () => {
    const outcome = await attempt(async () => {
      throw new Error("ECONNRESET while querying transactions where amount_cents = -842000");
    });

    expect(outcome.ok === false && outcome.reason).toBe("unavailable");
    expect(outcome.ok === false && outcome.state.formError).toBe(messageFor("unavailable"));
    expect(outcome.ok === false && outcome.state.formError).not.toContain("842000");
  });

  it("never exposes the message, cause, or any error object on the state", async () => {
    const outcome = await attempt(async () => {
      throw leakyError;
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    const serialized = JSON.stringify(outcome.state);
    expect(serialized).not.toContain("accounts_user_id_lower_name_key");
    expect(serialized).not.toContain("Chase Checking");
    expect(serialized).not.toContain("842000");
    expect(serialized).not.toContain("23505");
    // No error object travels along under any key.
    expect(Object.keys(outcome.state).sort()).toEqual(["fieldErrors", "formError", "status"]);
  });

  it("echoes the submitted values it was given, on failure", async () => {
    const outcome = await attempt(
      async () => {
        throw conflict();
      },
      { name: "Rent" }
    );

    expect(outcome.ok === false && outcome.state.values).toEqual({ name: "Rent" });
  });

  it("rejects rather than swallows nothing — a synchronous throw is caught too", async () => {
    const outcome = await attempt(() => {
      throw unavailable();
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("submittedValues()", () => {
  it("returns only the allowlisted string fields", () => {
    const formData = new FormData();
    formData.set("merchant", "Whole Foods");
    formData.set("amount", "12.34");
    formData.set("secret", "do-not-echo");

    expect(submittedValues(formData, ["merchant", "amount"])).toEqual({
      merchant: "Whole Foods",
      amount: "12.34",
    });
  });

  it("drops absent fields instead of inventing empty strings", () => {
    const formData = new FormData();
    formData.set("merchant", "Whole Foods");

    expect(submittedValues(formData, ["merchant", "note"])).toEqual({ merchant: "Whole Foods" });
  });

  it("drops a File rather than coercing it", () => {
    // String(file) is "[object File]", which would quietly pass a type check.
    const formData = new FormData();
    formData.set("attachment", new File(["x"], "statement.csv"));
    formData.set("merchant", "Whole Foods");

    expect(submittedValues(formData, ["attachment", "merchant"])).toEqual({
      merchant: "Whole Foods",
    });
  });

  it("keeps an empty string, which is a real submission", () => {
    // A cleared field is meaningful for repopulation — it is not "absent".
    const formData = new FormData();
    formData.set("note", "");

    expect(submittedValues(formData, ["note"])).toEqual({ note: "" });
  });

  it("freezes the result", () => {
    expect(Object.isFrozen(submittedValues(new FormData(), []))).toBe(true);
  });
});
