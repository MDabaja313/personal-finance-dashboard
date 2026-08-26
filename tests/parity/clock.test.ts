import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { calendarDateInTimeZone } from "@/lib/data/calendar";

const mocks = vi.hoisted(() => ({
  client: undefined as unknown,
  ownerId: undefined as unknown as string,
}));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getToday } = await import("@/lib/data/clock");

let context: Awaited<ReturnType<typeof createParityContext>>;

beforeAll(async () => {
  context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

/**
 * The integration half of the clock.
 *
 * Deliberately **not** compared against the fixture oracle's `getToday()`:
 * since Checkpoint 4 the production clock returns the real current date and
 * the oracle returns `MOCK_TODAY`, and they are supposed to differ. What is
 * asserted here is the part only a live database can show — that the timezone
 * really is read from `public.profiles` through RLS as the owner, and that the
 * answer is the current date *in that zone*.
 *
 * The deterministic conversion arithmetic (zone boundaries, DST, padding) is
 * pinned offline against fixed instants in `lib/data/calendar.test.ts`; none of
 * it depends on the wall clock.
 */
describe("getToday parity — the real clock, in the owner's real timezone", () => {
  it("returns the current calendar date in profiles.timezone", async () => {
    const before = calendarDateInTimeZone(new Date(), context.ownerTimezone);
    const today = await getToday();
    const after = calendarDateInTimeZone(new Date(), context.ownerTimezone);

    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Bracketed rather than equated, so a run that straddles local midnight
    // reports a real failure only if the answer is outside the window.
    expect([before, after]).toContain(today);
  });

  it("reads the timezone from the database rather than a constant in the suite", async () => {
    const { data, error } = await context.client
      .from("profiles")
      .select("timezone")
      .eq("id", context.ownerId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].timezone).toBe(context.ownerTimezone);

    // And that zone is the one the answer is expressed in: converting the same
    // instant in a zone a full day away gives a different date.
    const today = await getToday();
    expect(today).toBe(calendarDateInTimeZone(new Date(), data![0].timezone));
  });

  it("is free-running, not pinned to the oracle's MOCK_TODAY", async () => {
    const { MOCK_TODAY } = await import("@/lib/mock");
    const oracle = await import("@/lib/mock/dal");

    // The oracle still answers with the fixed fixture date — it is the offline
    // contract definition and must not drift.
    expect(await oracle.getToday()).toBe(MOCK_TODAY);

    // Production tracks real time instead. Asserted as "equals the real
    // current date in the owner's zone" rather than "differs from
    // MOCK_TODAY": the latter would be a false failure on the one day a year
    // the two coincide, while this holds every day, including that one.
    expect(await getToday()).toBe(calendarDateInTimeZone(new Date(), context.ownerTimezone));
  });
});
