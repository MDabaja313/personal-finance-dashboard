import { beforeEach, describe, expect, it, vi } from "vitest";

import { idle } from "@/lib/actions/result";
import { conflict, invalidInput, notFound, unauthorized, unavailable } from "@/lib/errors";

/**
 * The movement Server Actions, offline.
 *
 * Everything below the action is a spy: the mutation DAL, the clock, and the
 * two request-scoped Next.js functions. That is deliberate and is what makes
 * this suite worth having alongside `tests/mutations/movements.test.ts`, which
 * fakes only the Supabase seam and proves the wiring against a real database.
 * The questions here are ones a real database cannot answer:
 *
 * - Does invalid input stop *before* the mutation is called at all?
 * - Which routes exactly does a successful write revalidate — and, just as
 *   importantly, which does it not?
 * - Does a failure classification become the right message and the right
 *   navigation decision?
 * - Does a `getToday()` failure produce a safe state instead of escaping into
 *   the error boundary?
 *
 * Each of those is about control flow the action owns, and each is invisible to
 * an integration test that only observes the database afterwards.
 */

const mocks = vi.hoisted(() => ({
  today: "2026-08-28" as string,
  todayError: null as unknown,
  create: vi.fn(),
  replace: vi.fn(),
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

vi.mock("@/lib/data/mutations/movements", () => ({
  createMovement: (...args: unknown[]) => mocks.create(...args),
  replaceMovement: (...args: unknown[]) => mocks.replace(...args),
  deleteMovement: (...args: unknown[]) => mocks.remove(...args),
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

const actions = await import("@/lib/actions/movements");

const MOVEMENT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_LEG_ID = "00000000-0000-4000-8000-000000000002";
const DESTINATION_LEG_ID = "00000000-0000-4000-8000-000000000003";
const CHECKING = "00000000-0000-4000-8000-0000000000a1";
const SAVINGS = "00000000-0000-4000-8000-0000000000a2";

/**
 * The four routes a movement write must invalidate.
 *
 * `/budgets` is deliberately absent: a movement leg is excluded from
 * `countsAsSpending` **by kind**, so no movement write can change any figure
 * that page renders. Asserted as an exact array, in order, so adding a fifth
 * out of habit fails here.
 */
const MOVEMENT_ROUTES = ["/transactions", "/dashboard", "/accounts", "/analytics"];

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

function submission(overrides: Record<string, string> = {}): FormData {
  return formData({
    id: MOVEMENT_ID,
    sourceLegId: SOURCE_LEG_ID,
    destinationLegId: DESTINATION_LEG_ID,
    kind: "transfer",
    date: "2026-08-20",
    fromAccountId: CHECKING,
    toAccountId: SAVINGS,
    amount: "250.00",
    ...overrides,
  });
}

beforeEach(() => {
  mocks.today = "2026-08-28";
  mocks.todayError = null;
  mocks.create.mockReset().mockResolvedValue({ id: MOVEMENT_ID, deduplicated: false });
  mocks.replace.mockReset().mockResolvedValue({ id: MOVEMENT_ID, deduplicated: false });
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.revalidated = [];
  mocks.redirectedTo = null;
});

describe("createMovementAction — the happy path", () => {
  it("passes the validated input to the mutation, with the amount as a magnitude", async () => {
    const state = await actions.createMovementAction(idle(), submission());

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({
      id: MOVEMENT_ID,
      sourceLegId: SOURCE_LEG_ID,
      destinationLegId: DESTINATION_LEG_ID,
      kind: "transfer",
      date: "2026-08-20",
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      amountCents: 25_000,
    });
  });

  it("revalidates exactly the four movement routes, and never /budgets or /", async () => {
    await actions.createMovementAction(idle(), submission());

    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
    expect(mocks.revalidated).not.toContain("/budgets");
    expect(mocks.revalidated).not.toContain("/");
  });

  it("reports a deduplicated retry as an ordinary success", async () => {
    // Deliberately indistinguishable from a first-time create: a retry that
    // matched an identical stored movement *did* accomplish what the person
    // asked for, and reporting it differently would invite them to submit
    // again.
    mocks.create.mockResolvedValue({ id: MOVEMENT_ID, deduplicated: true });

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();
    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
  });

  it("accepts a credit card payment", async () => {
    await actions.createMovementAction(idle(), submission({ kind: "credit_card_payment" }));

    expect(mocks.create.mock.calls[0][0].kind).toBe("credit_card_payment");
  });
});

describe("createMovementAction — validation stops before the database", () => {
  it("refuses the same account twice, without calling the mutation", async () => {
    const state = await actions.createMovementAction(
      idle(),
      submission({ toAccountId: CHECKING })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.toAccountId?.length).toBeGreaterThan(0);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revalidated).toEqual([]);
  });

  it("refuses a zero amount, without calling the mutation", async () => {
    const state = await actions.createMovementAction(idle(), submission({ amount: "0" }));

    expect(state.status).toBe("error");
    expect(state.fieldErrors.amount?.length).toBeGreaterThan(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses the owner's tomorrow, without calling the mutation", async () => {
    const state = await actions.createMovementAction(idle(), submission({ date: "2026-08-29" }));

    expect(state.status).toBe("error");
    expect(state.fieldErrors.date?.length).toBeGreaterThan(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an ordinary transaction kind, without calling the mutation", async () => {
    for (const kind of ["expense", "income", "refund", "adjustment"]) {
      mocks.create.mockClear();
      const state = await actions.createMovementAction(idle(), submission({ kind }));

      expect(state.status, `${kind} must be refused`).toBe("error");
      expect(state.fieldErrors.kind?.length).toBeGreaterThan(0);
      expect(mocks.create).not.toHaveBeenCalled();
    }
  });

  it("uses the owner's own calendar day as the ceiling, not the system clock", async () => {
    // The same date is refused against one ceiling and accepted against a
    // later one. Both come from `getToday()`, which reads profiles.timezone.
    mocks.today = "2026-08-19";
    expect((await actions.createMovementAction(idle(), submission())).status).toBe("error");

    mocks.today = "2026-08-20";
    expect((await actions.createMovementAction(idle(), submission())).status).toBe("success");
  });

  it("echoes the submitted text back so a rejected form is not blanked", async () => {
    const state = await actions.createMovementAction(
      idle(),
      submission({ amount: "0", date: "2026-08-14" })
    );

    expect(state.values).toEqual({
      kind: "transfer",
      date: "2026-08-14",
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      amount: "0",
    });
  });

  it("never echoes the three ids back", async () => {
    // `values` is the one part of an ActionState sourced from untrusted input.
    // The ids are hidden inputs a person cannot retype, so there is no benefit
    // to putting caller-supplied UUIDs into it.
    const state = await actions.createMovementAction(idle(), submission({ amount: "nope" }));

    expect(state.values).not.toHaveProperty("id");
    expect(state.values).not.toHaveProperty("sourceLegId");
    expect(state.values).not.toHaveProperty("destinationLegId");
  });
});

describe("createMovementAction — failure classification", () => {
  it("redirects to /login when the session has ended", async () => {
    mocks.create.mockRejectedValue(unauthorized());

    await expect(actions.createMovementAction(idle(), submission())).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );

    expect(mocks.redirectedTo).toBe("/login");
    expect(mocks.revalidated).toEqual([]);
  });

  it("turns an idempotency-key conflict into its own sentence", async () => {
    mocks.create.mockRejectedValue(conflict("A different transfer was already saved."));

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/already saved/i);
    // Not the generic conflict sentence: "that conflicts with something that
    // already exists" is not actionable.
    expect(state.formError).not.toBe("That conflicts with something that already exists.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("turns an unusable account into an actionable sentence", async () => {
    // An archived account on either side, or a card payment aimed at something
    // that is not a credit account. The pickers only offer active accounts and
    // only offer credit accounts as a payment's destination, so reaching this
    // means the page is stale.
    mocks.create.mockRejectedValue(invalidInput("That account is archived."));

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/refresh the page/i);
  });

  it("never quotes the underlying error's own message", async () => {
    // The AppError's message may name a column or an operation; the
    // *classification* is what selects the sentence.
    mocks.create.mockRejectedValue(invalidInput("movements_pkey on public.movements: -25000"));

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.formError).not.toMatch(/movements_pkey/);
    expect(state.formError).not.toMatch(/25000/);
  });

  it("falls back to the generic message for anything unrecognized", async () => {
    mocks.create.mockRejectedValue(unavailable());

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.status).toBe("error");
    expect(state.formError).toBe("Something went wrong. Please try again.");
  });
});

describe("getToday() failures are handled at the action layer", () => {
  it("redirects to /login when the clock read is unauthenticated", async () => {
    mocks.todayError = unauthorized();

    await expect(actions.createMovementAction(idle(), submission())).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("turns any other clock failure into a safe ActionState, never a thrown error", async () => {
    // A form that vanishes into a full-page error because a timezone lookup
    // blipped is strictly worse than one that says "try again".
    mocks.todayError = unavailable();

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.status).toBe("error");
    expect(state.formError).toBe("Something went wrong. Please try again.");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revalidated).toEqual([]);
  });

  it("keeps the person's typed values through a clock failure", async () => {
    mocks.todayError = unavailable();

    const state = await actions.createMovementAction(idle(), submission());

    expect(state.values?.amount).toBe("250.00");
  });
});

describe("updateMovementAction", () => {
  it("passes the validated input through and revalidates the same four routes", async () => {
    const state = await actions.updateMovementAction(
      idle(),
      submission({ amount: "300.00", date: "2026-08-21" })
    );

    expect(state.status).toBe("success");
    expect(mocks.replace).toHaveBeenCalledWith({
      id: MOVEMENT_ID,
      sourceLegId: SOURCE_LEG_ID,
      destinationLegId: DESTINATION_LEG_ID,
      kind: "transfer",
      date: "2026-08-21",
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      amountCents: 30_000,
    });
    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
  });

  it("reuses the movement's own id and both leg ids — an edit re-identifies nothing", async () => {
    await actions.updateMovementAction(idle(), submission({ amount: "1.00" }));

    const passed = mocks.replace.mock.calls[0][0];
    expect(passed.id).toBe(MOVEMENT_ID);
    expect(passed.sourceLegId).toBe(SOURCE_LEG_ID);
    expect(passed.destinationLegId).toBe(DESTINATION_LEG_ID);
  });

  it("revalidates even when the mutation reports nothing changed", async () => {
    // The write is what was skipped, not the render.
    mocks.replace.mockResolvedValue({ id: MOVEMENT_ID, deduplicated: true });

    const state = await actions.updateMovementAction(idle(), submission());

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
  });

  it("refuses an ordinary kind, so an edit cannot retype a movement", async () => {
    const state = await actions.updateMovementAction(idle(), submission({ kind: "expense" }));

    expect(state.status).toBe("error");
    expect(state.fieldErrors.kind?.length).toBeGreaterThan(0);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("reports a vanished movement as no longer existing", async () => {
    mocks.replace.mockRejectedValue(notFound());

    const state = await actions.updateMovementAction(idle(), submission());

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("reports an unusable account as an actionable sentence", async () => {
    mocks.replace.mockRejectedValue(
      invalidInput("A card payment must be paid into a credit account.")
    );

    const state = await actions.updateMovementAction(idle(), submission());

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/refresh the page/i);
  });

  it("redirects to /login on an ended session", async () => {
    mocks.replace.mockRejectedValue(unauthorized());

    await expect(actions.updateMovementAction(idle(), submission())).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );
  });
});

describe("deleteMovementAction", () => {
  it("deletes by movement id and revalidates the same four routes", async () => {
    const state = await actions.deleteMovementAction(idle(), formData({ id: MOVEMENT_ID }));

    expect(state.status).toBe("success");
    // The *movement's* id — there is no action anywhere that takes a leg id.
    expect(mocks.remove).toHaveBeenCalledWith(MOVEMENT_ID);
    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
  });

  it("refuses a malformed id without calling the mutation", async () => {
    const state = await actions.deleteMovementAction(idle(), formData({ id: "nope" }));

    expect(state.status).toBe("error");
    expect(state.fieldErrors.id?.length).toBeGreaterThan(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("does not read the clock — a delete has no date to validate", async () => {
    mocks.todayError = unavailable();

    const state = await actions.deleteMovementAction(idle(), formData({ id: MOVEMENT_ID }));

    expect(state.status).toBe("success");
  });

  it("reports a vanished movement as no longer existing", async () => {
    mocks.remove.mockRejectedValue(notFound());

    const state = await actions.deleteMovementAction(idle(), formData({ id: MOVEMENT_ID }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("reports an archived account as an actionable sentence", async () => {
    mocks.remove.mockRejectedValue(invalidInput("That account is archived."));

    const state = await actions.deleteMovementAction(idle(), formData({ id: MOVEMENT_ID }));

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/refresh the page/i);
  });

  it("redirects to /login on an ended session", async () => {
    mocks.remove.mockRejectedValue(unauthorized());

    await expect(
      actions.deleteMovementAction(idle(), formData({ id: MOVEMENT_ID }))
    ).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});
