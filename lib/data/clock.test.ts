/**
 * Offline unit tests for the production clock's *data* path — the profile
 * read, its failure modes, and the fact that the zone it finds is the zone the
 * conversion uses.
 *
 * The conversion arithmetic itself is pinned in `calendar.test.ts` against
 * fixed instants. Here the instant is the real `new Date()`, so nothing
 * asserts a *literal* date; what is asserted is the relationship — the answer
 * equals `calendarDateInTimeZone` of the same moment in the profile's zone,
 * and two different profile zones can legitimately disagree by a day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { calendarDateInTimeZone } from "@/lib/data/calendar";
import { AppError, isAppError } from "@/lib/errors";

const OWNER_ID = "c9152b5e-a931-4fe5-907a-64325a1a47ff";

const mocks = vi.hoisted(() => {
  /** Records the query chain so the predicate can be asserted, not assumed. */
  const eq = vi.fn();
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const getOwnerId = vi.fn(async () => OWNER_ID);
  return { eq, select, from, getOwnerId };
});

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => ({ from: mocks.from }),
  getOwnerId: mocks.getOwnerId,
}));

const { getToday } = await import("@/lib/data/clock");

function resolvesWith(rows: unknown, error: unknown = null) {
  mocks.eq.mockResolvedValue({ data: rows, error });
}

async function caught(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (isAppError(error)) return error;
    throw new Error(`Expected an AppError, received: ${String(error)}`);
  }
  throw new Error("Expected getToday to throw, but it resolved.");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerId.mockResolvedValue(OWNER_ID);
});

describe("getToday", () => {
  it("reads profiles.timezone scoped explicitly to the verified owner", async () => {
    resolvesWith([{ timezone: "UTC" }]);

    await getToday();

    expect(mocks.getOwnerId).toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith("profiles");
    expect(mocks.select).toHaveBeenCalledWith("timezone");
    expect(mocks.eq).toHaveBeenCalledWith("id", OWNER_ID);
  });

  it("returns the current calendar date in the profile's zone", async () => {
    for (const timezone of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Auckland"]) {
      resolvesWith([{ timezone }]);

      const today = await getToday();

      // Same instant, same conversion — the only thing this asserts is that
      // the zone from the row is the zone actually applied. A tick between the
      // two reads could differ by a day only across a local midnight, so the
      // comparison allows the adjacent date.
      const expected = calendarDateInTimeZone(new Date(), timezone);
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect([expected, calendarDateInTimeZone(new Date(), timezone)]).toContain(today);
    }
  });

  it("is genuinely zone-dependent — two zones a day apart disagree", async () => {
    // Kiritimati (UTC+14) and Honolulu (UTC-10) are 24 hours apart, so at
    // every instant they are on different calendar dates.
    resolvesWith([{ timezone: "Pacific/Kiritimati" }]);
    const ahead = await getToday();
    resolvesWith([{ timezone: "Pacific/Honolulu" }]);
    const behind = await getToday();

    expect(ahead).not.toBe(behind);
    expect(ahead > behind).toBe(true);
  });

  it("fails as data_integrity when the owner has no profile — never falls back to UTC", async () => {
    resolvesWith([]);

    const error = await caught(() => getToday());

    expect(error.code).toBe("data_integrity");
    expect(error.message).toBe("Expected exactly one owner profile.");
  });

  it("fails as data_integrity when more than one profile row comes back", async () => {
    resolvesWith([{ timezone: "UTC" }, { timezone: "Asia/Tokyo" }]);

    expect((await caught(() => getToday())).code).toBe("data_integrity");
  });

  it("fails as data_integrity for an unusable timezone value in the row", async () => {
    for (const timezone of ["Not/AZone", "", null]) {
      resolvesWith([{ timezone }]);

      expect((await caught(() => getToday())).code).toBe("data_integrity");
    }
  });

  it("routes a query failure through mapDbError rather than reading data", async () => {
    resolvesWith(null, { code: "42501", message: "permission denied for table profiles" });

    const error = await caught(() => getToday());

    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("Not permitted to read the owner profile.");
    // The raw driver message stays in `cause`, server-side only.
    expect(error.message).not.toContain("permission denied");
  });

  it("maps an expired JWT to unauthorized", async () => {
    resolvesWith(null, { code: "PGRST301", message: "JWT expired" });

    expect((await caught(() => getToday())).code).toBe("unauthorized");
  });

  it("maps an unclassified failure to unavailable", async () => {
    resolvesWith(null, { message: "connection reset" });

    expect((await caught(() => getToday())).code).toBe("unavailable");
  });

  it("propagates an unauthorized owner rather than answering with a date", async () => {
    mocks.getOwnerId.mockRejectedValue(new AppError("unauthorized", "Not authenticated."));

    expect((await caught(() => getToday())).code).toBe("unauthorized");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
