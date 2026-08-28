import { beforeEach, describe, expect, it, vi } from "vitest";

import { idle } from "@/lib/actions/result";
import { conflict, invalidInput, notFound, unauthorized, unavailable } from "@/lib/errors";

/**
 * The transaction Server Actions, offline.
 *
 * Everything below the action is a spy: the mutation DAL, the clock, and the
 * two request-scoped Next.js functions. That is deliberate and is what makes
 * this suite worth having alongside `tests/mutations/**`, which fakes only the
 * Supabase seam and proves the wiring against a real database. The questions
 * here are ones a real database cannot answer:
 *
 * - Does invalid input stop *before* the mutation is called at all?
 * - Which routes exactly does a successful write revalidate?
 * - Does a failure classification become the right message and the right
 *   navigation decision?
 * - Does a `getToday()` failure produce a safe state instead of escaping into
 *   the error boundary?
 *
 * Each of those is about control flow the action owns, and each is invisible to
 * an integration test that only observes the database afterwards.
 */

const mocks = vi.hoisted(() => ({
  today: "2026-08-27" as string,
  todayError: null as unknown,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  revalidated: [] as string[],
  redirectedTo: null as string | null,
}));

vi.mock("@/lib/data/clock", () => ({
  getToday: async () => {
    if (mocks.todayError !== null) throw mocks.todayError;
    return mocks.today;
  },
}));

vi.mock("@/lib/data/mutations/transactions", () => ({
  createTransaction: (...args: unknown[]) => mocks.create(...args),
  updateTransaction: (...args: unknown[]) => mocks.update(...args),
  deleteTransaction: (...args: unknown[]) => mocks.remove(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    mocks.revalidated.push(path);
  },
}));

vi.mock("next/navigation", () => ({
  // The real redirect() signals by throwing, so this one must too: an action
  // that redirects must not fall through to the code after it.
  redirect: (path: string) => {
    mocks.redirectedTo = path;
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

const actions = await import("@/lib/actions/transactions");

/** The exact route set a transaction write must invalidate, in order. */
const TRANSACTION_ROUTES = [
  "/transactions",
  "/dashboard",
  "/accounts",
  "/budgets",
  "/analytics",
];

const ACCOUNT = "6f4e2f3a-1a2b-4c3d-8e9f-000000000001";
const CATEGORY = "6f4e2f3a-1a2b-4c3d-8e9f-000000000002";
const KEY = "6f4e2f3a-1a2b-4c3d-8e9f-000000000003";
const ROW = "6f4e2f3a-1a2b-4c3d-8e9f-000000000004";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

function createForm(overrides: Record<string, string> = {}): FormData {
  return formData({
    id: KEY,
    accountId: ACCOUNT,
    date: "2026-08-20",
    merchant: "Whole Foods",
    kind: "expense",
    categoryId: CATEGORY,
    amount: "42.50",
    ...overrides,
  });
}

beforeEach(() => {
  mocks.today = "2026-08-27";
  mocks.todayError = null;
  mocks.revalidated = [];
  mocks.redirectedTo = null;
  mocks.create.mockReset().mockResolvedValue({ id: KEY, deduplicated: false });
  mocks.update.mockReset().mockResolvedValue(undefined);
  mocks.remove.mockReset().mockResolvedValue(undefined);
});

describe("createTransactionAction — the happy path", () => {
  it("passes the validated, sign-derived input to the mutation", async () => {
    const state = await actions.createTransactionAction(idle(), createForm());

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      id: KEY,
      accountId: ACCOUNT,
      date: "2026-08-20",
      merchant: "Whole Foods",
      kind: "expense",
      categoryId: CATEGORY,
      amountCents: -4250,
    });
  });

  it("revalidates exactly the five transaction routes", async () => {
    await actions.createTransactionAction(idle(), createForm());
    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);
    // Never the catch-all: it would discard every cached route to refresh five.
    expect(mocks.revalidated).not.toContain("/");
  });

  it("reports a deduplicated retry as an ordinary success", async () => {
    // A retry that matched an identical stored row *did* accomplish what the
    // person asked for. Reporting it differently would invite them to submit
    // again — which is the behaviour idempotency exists to prevent.
    mocks.create.mockResolvedValue({ id: KEY, deduplicated: true });

    const state = await actions.createTransactionAction(idle(), createForm());

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();
    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);
  });
});

describe("createTransactionAction — validation stops before the database", () => {
  it.each([
    ["a future date", { date: "2026-08-28" }, "date"],
    ["a blank merchant", { merchant: "   " }, "merchant"],
    ["a signed amount", { amount: "-42.50" }, "amount"],
    ["a malformed amount", { amount: "1e5" }, "amount"],
    ["a missing idempotency key", { id: "" }, "id"],
    ["a movement kind", { kind: "transfer", categoryId: "" }, "kind"],
    ["an adjustment kind", { kind: "adjustment", categoryId: "" }, "kind"],
    ["a malformed account id", { accountId: "nope" }, "accountId"],
  ])("refuses %s without calling the mutation", async (_label, overrides, field) => {
    const state = await actions.createTransactionAction(idle(), createForm(overrides));

    expect(state.status).toBe("error");
    expect(state.fieldErrors[field]?.length).toBeGreaterThan(0);
    expect(mocks.create).not.toHaveBeenCalled();
    // Nothing changed, so nothing may be invalidated.
    expect(mocks.revalidated).toEqual([]);
  });

  it("echoes the submitted text back so a rejected form is not blanked", async () => {
    const state = await actions.createTransactionAction(
      idle(),
      createForm({ date: "2026-08-28" })
    );

    expect(state.values).toMatchObject({
      merchant: "Whole Foods",
      amount: "42.50",
      date: "2026-08-28",
    });
    // The idempotency key is never echoed — it is not a field a person edits,
    // and echoing it would put it in the rendered HTML for no purpose.
    expect(state.values).not.toHaveProperty("id");
  });

  it("uses the owner's own calendar day as the ceiling, not the system clock", async () => {
    // Same submission, different owner-local today: what is acceptable in one
    // timezone is the future in another. The action must take the date from
    // getToday(), which reads profiles.timezone.
    mocks.today = "2026-08-19";
    const rejected = await actions.createTransactionAction(idle(), createForm());
    expect(rejected.status).toBe("error");
    expect(rejected.fieldErrors.date?.length).toBeGreaterThan(0);
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.today = "2026-08-20";
    const accepted = await actions.createTransactionAction(idle(), createForm());
    expect(accepted.status).toBe("success");
  });
});

describe("createTransactionAction — failure classification", () => {
  it("redirects to /login when the session has ended", async () => {
    mocks.create.mockRejectedValue(unauthorized());

    await expect(actions.createTransactionAction(idle(), createForm())).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(mocks.redirectedTo).toBe("/login");
    expect(mocks.revalidated).toEqual([]);
  });

  it("turns an idempotency-key conflict into its own sentence", async () => {
    mocks.create.mockRejectedValue(conflict("A different transaction was already saved."));

    const state = await actions.createTransactionAction(idle(), createForm());

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/already saved/i);
    // The DAL's own message is never quoted onward — the classification picks
    // the sentence from a constant table.
    expect(state.formError).not.toBe("A different transaction was already saved.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("turns an unusable account or category into an actionable sentence", async () => {
    mocks.create.mockRejectedValue(invalidInput("That account is archived."));

    const state = await actions.createTransactionAction(idle(), createForm());

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/account or category/i);
  });

  it("falls back to the generic message for anything unrecognized", async () => {
    mocks.create.mockRejectedValue(new Error("connection reset by peer"));

    const state = await actions.createTransactionAction(idle(), createForm());

    expect(state.status).toBe("error");
    expect(state.formError).toBe("Something went wrong. Please try again.");
    // The raw message must not survive into anything a browser receives.
    expect(JSON.stringify(state)).not.toMatch(/connection reset/);
  });
});

describe("getToday() failures are handled at the action layer", () => {
  it("redirects to /login when the clock read is unauthenticated", async () => {
    mocks.todayError = unauthorized();

    await expect(actions.createTransactionAction(idle(), createForm())).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(mocks.redirectedTo).toBe("/login");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("turns any other clock failure into a safe ActionState, never a thrown error", async () => {
    // A form that vanishes into a full-page error boundary because a timezone
    // lookup blipped is strictly worse than one that says "try again".
    mocks.todayError = unavailable("Failed to load the owner profile.");

    const state = await actions.createTransactionAction(idle(), createForm());

    expect(state.status).toBe("error");
    expect(state.formError).toBe("Something went wrong. Please try again.");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revalidated).toEqual([]);
  });

  it("keeps the person's typed values through a clock failure", async () => {
    mocks.todayError = unavailable();
    const state = await actions.createTransactionAction(idle(), createForm());
    expect(state.values).toMatchObject({ merchant: "Whole Foods" });
  });
});

describe("updateTransactionAction", () => {
  it("passes the validated input through and revalidates the same five routes", async () => {
    const state = await actions.updateTransactionAction(
      idle(),
      createForm({ id: ROW, kind: "income", categoryId: CATEGORY, amount: "10.00" })
    );

    expect(state.status).toBe("success");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      id: ROW,
      accountId: ACCOUNT,
      date: "2026-08-20",
      merchant: "Whole Foods",
      kind: "income",
      categoryId: CATEGORY,
      amountCents: 1000,
    });
    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);
  });

  it("refuses to retype a row into an adjustment", async () => {
    const state = await actions.updateTransactionAction(
      idle(),
      createForm({ id: ROW, kind: "adjustment", categoryId: "" })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.kind?.length).toBeGreaterThan(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reports a movement leg or adjustment refused by the DAL as an actionable sentence", async () => {
    mocks.update.mockRejectedValue(invalidInput("A balance adjustment cannot be edited."));

    const state = await actions.updateTransactionAction(idle(), createForm({ id: ROW }));

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/account or category/i);
    expect(mocks.revalidated).toEqual([]);
  });

  it("redirects to /login on an ended session", async () => {
    mocks.update.mockRejectedValue(unauthorized());
    await expect(
      actions.updateTransactionAction(idle(), createForm({ id: ROW }))
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirectedTo).toBe("/login");
  });
});

describe("deleteTransactionAction", () => {
  it("deletes by id and revalidates the same five routes", async () => {
    const state = await actions.deleteTransactionAction(idle(), formData({ id: ROW }));

    expect(state.status).toBe("success");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(ROW);
    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);
  });

  it("refuses a malformed id without calling the mutation", async () => {
    const state = await actions.deleteTransactionAction(idle(), formData({ id: "nope" }));

    expect(state.status).toBe("error");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revalidated).toEqual([]);
  });

  it("names the bill occurrence as the specific remedy", async () => {
    // On delete, `conflict` has exactly one meaning — a bill occurrence records
    // this transaction as its payment — so the sentence can be specific.
    mocks.remove.mockRejectedValue(conflict("Unmark that bill as paid first."));

    const state = await actions.deleteTransactionAction(idle(), formData({ id: ROW }));

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/unmark that bill as paid/i);
    expect(mocks.revalidated).toEqual([]);
  });

  it("reports a vanished row as no longer existing", async () => {
    mocks.remove.mockRejectedValue(notFound("That transaction does not exist."));

    const state = await actions.deleteTransactionAction(idle(), formData({ id: ROW }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });

  it("does not read the clock — a delete has no date to validate", async () => {
    // If it ever did, a clock failure would make deletion impossible for reasons
    // that have nothing to do with the row being deleted.
    mocks.todayError = unavailable();

    const state = await actions.deleteTransactionAction(idle(), formData({ id: ROW }));

    expect(state.status).toBe("success");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(ROW);
  });

  it("redirects to /login on an ended session", async () => {
    mocks.remove.mockRejectedValue(unauthorized());
    await expect(
      actions.deleteTransactionAction(idle(), formData({ id: ROW }))
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirectedTo).toBe("/login");
  });
});
