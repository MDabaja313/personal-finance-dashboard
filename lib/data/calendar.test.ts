/**
 * Offline unit tests for the instant → calendar-date conversion.
 *
 * Every case supplies a **fixed** instant. That is the whole point of the
 * helper existing separately from `getToday()`: the interesting behavior —
 * that "what day is it" genuinely depends on the zone, and that the assembled
 * string is `YYYY-MM-DD` regardless of host locale — is asserted
 * deterministically, with nothing riding on when the suite happens to run.
 */
import { describe, expect, it } from "vitest";

import { calendarDateInTimeZone } from "@/lib/data/calendar";
import { isAppError } from "@/lib/errors";

/** 2026-08-20T23:30:00Z — evening in New York, already tomorrow in Tokyo. */
const ACROSS_MIDNIGHT = new Date("2026-08-20T23:30:00.000Z");

function caught(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (!isAppError(error)) throw new Error(`Expected an AppError, received: ${String(error)}`);
    return { code: error.code, message: error.message };
  }
  throw new Error("Expected calendarDateInTimeZone to throw, but it returned.");
}

describe("calendarDateInTimeZone", () => {
  it("resolves the same instant to different calendar dates either side of midnight", () => {
    // 19:30 on the 20th in New York (UTC-4 in August)...
    expect(calendarDateInTimeZone(ACROSS_MIDNIGHT, "America/New_York")).toBe("2026-08-20");
    // ...and 08:30 on the 21st in Tokyo (UTC+9), from the very same instant.
    expect(calendarDateInTimeZone(ACROSS_MIDNIGHT, "Asia/Tokyo")).toBe("2026-08-21");
    expect(calendarDateInTimeZone(ACROSS_MIDNIGHT, "UTC")).toBe("2026-08-20");
  });

  it("rolls the date over exactly at local midnight, not at UTC midnight", () => {
    // 04:00Z is 00:00 in New York on the 21st — the first instant of the new
    // local day, four hours before UTC agrees.
    const localMidnight = new Date("2026-08-21T04:00:00.000Z");
    expect(calendarDateInTimeZone(localMidnight, "America/New_York")).toBe("2026-08-21");
    expect(calendarDateInTimeZone(new Date("2026-08-21T03:59:59.999Z"), "America/New_York")).toBe(
      "2026-08-20"
    );
    expect(calendarDateInTimeZone(localMidnight, "UTC")).toBe("2026-08-21");
  });

  it("handles a zone ahead of the date line and a half-hour offset zone", () => {
    expect(calendarDateInTimeZone(ACROSS_MIDNIGHT, "Pacific/Kiritimati")).toBe("2026-08-21");
    expect(calendarDateInTimeZone(ACROSS_MIDNIGHT, "Asia/Kolkata")).toBe("2026-08-21");
    expect(calendarDateInTimeZone(ACROSS_MIDNIGHT, "Pacific/Honolulu")).toBe("2026-08-20");
  });

  it("is DST-correct — the same wall date on both sides of a transition", () => {
    // US DST ends 2026-11-01. 05:30Z is 01:30 EDT (before) / 00:30 EST (after)
    // depending on the year's rule; both fall on 2026-11-01 locally.
    expect(calendarDateInTimeZone(new Date("2026-11-01T05:30:00.000Z"), "America/New_York")).toBe(
      "2026-11-01"
    );
    expect(calendarDateInTimeZone(new Date("2026-03-08T07:30:00.000Z"), "America/New_York")).toBe(
      "2026-03-08"
    );
  });

  it("always produces a zero-padded YYYY-MM-DD, never a locale-formatted string", () => {
    for (const instant of [
      new Date("2026-01-02T12:00:00.000Z"),
      new Date("2026-09-09T12:00:00.000Z"),
      new Date("2026-12-31T12:00:00.000Z"),
    ]) {
      const result = calendarDateInTimeZone(instant, "UTC");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(calendarDateInTimeZone(new Date("2026-01-02T12:00:00.000Z"), "UTC")).toBe("2026-01-02");
  });

  it("rejects an unrecognized timezone as data_integrity, without quoting it", () => {
    for (const zone of ["Not/AZone", "Mars/Olympus_Mons", "America/New York"]) {
      const error = caught(() => calendarDateInTimeZone(ACROSS_MIDNIGHT, zone));
      expect(error.code).toBe("data_integrity");
      expect(error.message).toBe("Unrecognized timezone on the owner profile.");
      expect(error.message).not.toContain(zone);
    }
  });

  it("rejects a missing, empty, or non-string timezone rather than defaulting to UTC", () => {
    for (const zone of [undefined, null, "", "   ", 42, {}]) {
      const error = caught(() => calendarDateInTimeZone(ACROSS_MIDNIGHT, zone));
      expect(error.code).toBe("data_integrity");
      expect(error.message).toBe("Missing timezone on the owner profile.");
    }
  });

  it("reports an invalid instant distinctly from an invalid timezone", () => {
    const error = caught(() => calendarDateInTimeZone(new Date(NaN), "UTC"));
    expect(error.code).toBe("data_integrity");
    expect(error.message).toBe("Invalid instant for the owner's current date.");
  });
});
