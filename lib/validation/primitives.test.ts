import { describe, expect, it } from "vitest";

import {
  NAME_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  blankToUndefined,
  zCalendarDate,
  zMonthKey,
  zName,
  zNotFuture,
  zOptionalNote,
  zOptionalUuid,
  zUuid,
} from "@/lib/validation/primitives";

const UUID = "1f4b3a2c-6d5e-4f8a-9b0c-1d2e3f4a5b6c";

describe("zUuid / zOptionalUuid", () => {
  it("accepts a UUID and rejects anything else", () => {
    expect(zUuid.safeParse(UUID).success).toBe(true);
    expect(zUuid.safeParse("not-a-uuid").success).toBe(false);
    expect(zUuid.safeParse("").success).toBe(false);
    expect(zUuid.safeParse(123).success).toBe(false);
  });

  it("maps an unselected optional select ('') to undefined", () => {
    // An unfilled HTML control submits "", never undefined. Without this, an
    // untouched optional <select> would fail as a malformed UUID.
    const parsed = zOptionalUuid.safeParse("");
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBeUndefined();
  });

  it("treats a whitespace-only optional select as unselected", () => {
    expect(zOptionalUuid.safeParse("   ").data).toBeUndefined();
  });

  it("still validates a present optional id", () => {
    expect(zOptionalUuid.safeParse(UUID).data).toBe(UUID);
    expect(zOptionalUuid.safeParse("nope").success).toBe(false);
  });

  it("accepts an absent optional id", () => {
    expect(zOptionalUuid.safeParse(undefined).success).toBe(true);
  });
});

describe("zName", () => {
  it("trims and keeps the trimmed value", () => {
    // Untrimmed names defeat the case-insensitive uniqueness index on
    // categories(user_id, lower(name)) — " Rent" and "Rent" would coexist.
    expect(zName.safeParse("  Rent  ").data).toBe("Rent");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(zName.safeParse("").success).toBe(false);
    expect(zName.safeParse("   ").success).toBe(false);
  });

  it("bounds the length", () => {
    expect(zName.safeParse("a".repeat(NAME_MAX_LENGTH)).success).toBe(true);
    expect(zName.safeParse("a".repeat(NAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(zName.safeParse(42).success).toBe(false);
    expect(zName.safeParse(null).success).toBe(false);
  });
});

describe("zOptionalNote", () => {
  it("maps an untouched field to undefined rather than an empty string", () => {
    // "absent" must reach the domain as undefined — the same convention the
    // row mappers enforce from the database side.
    expect(zOptionalNote.safeParse("").data).toBeUndefined();
    expect(zOptionalNote.safeParse("   ").data).toBeUndefined();
    expect(zOptionalNote.safeParse(undefined).data).toBeUndefined();
  });

  it("trims and bounds a present note", () => {
    expect(zOptionalNote.safeParse("  paid early  ").data).toBe("paid early");
    expect(zOptionalNote.safeParse("a".repeat(NOTE_MAX_LENGTH)).success).toBe(true);
    expect(zOptionalNote.safeParse("a".repeat(NOTE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe("blankToUndefined", () => {
  it("only collapses blank strings, and passes everything else through", () => {
    expect(blankToUndefined("")).toBeUndefined();
    expect(blankToUndefined("  ")).toBeUndefined();
    expect(blankToUndefined("x")).toBe("x");
    expect(blankToUndefined(0)).toBe(0);
    expect(blankToUndefined(null)).toBeNull();
  });
});

describe("zCalendarDate", () => {
  it("accepts a real 'YYYY-MM-DD' date, trimmed", () => {
    expect(zCalendarDate.safeParse("2026-08-27").data).toBe("2026-08-27");
    expect(zCalendarDate.safeParse("  2026-08-27  ").data).toBe("2026-08-27");
    expect(zCalendarDate.safeParse("2024-02-29").success).toBe(true); // leap year
  });

  it("rejects a well-formed date that does not exist", () => {
    // The structural check alone accepts all of these.
    expect(zCalendarDate.safeParse("2026-02-30").success).toBe(false);
    expect(zCalendarDate.safeParse("2026-13-01").success).toBe(false);
    expect(zCalendarDate.safeParse("2026-00-10").success).toBe(false);
    expect(zCalendarDate.safeParse("2026-04-31").success).toBe(false);
    expect(zCalendarDate.safeParse("2025-02-29").success).toBe(false); // not a leap year
    expect(zCalendarDate.safeParse("2026-01-00").success).toBe(false);
  });

  it("rejects any other shape, including a timestamp", () => {
    for (const value of [
      "2026-8-27",
      "27/08/2026",
      "2026-08-27T00:00:00Z",
      "20260827",
      "",
      "today",
      "0099-01-01",
    ]) {
      expect(zCalendarDate.safeParse(value).success).toBe(false);
    }
  });
});

describe("zMonthKey", () => {
  it("accepts a structural 'YYYY-MM'", () => {
    expect(zMonthKey.safeParse("2026-08").data).toBe("2026-08");
    expect(zMonthKey.safeParse("  2026-01  ").data).toBe("2026-01");
    expect(zMonthKey.safeParse("2026-12").success).toBe(true);
  });

  it("rejects an impossible or malformed month", () => {
    for (const value of ["2026-13", "2026-00", "2026-8", "2026", "2026-08-01", ""]) {
      expect(zMonthKey.safeParse(value).success).toBe(false);
    }
  });
});

describe("zNotFuture", () => {
  const TODAY = "2026-08-27";

  it("accepts today and every earlier date", () => {
    expect(zNotFuture(TODAY).safeParse(TODAY).success).toBe(true);
    expect(zNotFuture(TODAY).safeParse("2026-08-26").success).toBe(true);
    expect(zNotFuture(TODAY).safeParse("2019-01-01").success).toBe(true);
  });

  it("rejects tomorrow and beyond", () => {
    expect(zNotFuture(TODAY).safeParse("2026-08-28").success).toBe(false);
    expect(zNotFuture(TODAY).safeParse("2027-01-01").success).toBe(false);
  });

  it("compares across month and year boundaries correctly", () => {
    // Zero-padded fixed-width dates make lexicographic order chronological —
    // no Date object is constructed, so no timezone enters the comparison.
    expect(zNotFuture("2026-01-01").safeParse("2025-12-31").success).toBe(true);
    expect(zNotFuture("2025-12-31").safeParse("2026-01-01").success).toBe(false);
  });

  it("still applies the full calendar-date check", () => {
    expect(zNotFuture(TODAY).safeParse("2026-02-30").success).toBe(false);
    expect(zNotFuture(TODAY).safeParse("not-a-date").success).toBe(false);
  });

  it("takes `today` explicitly and reads no clock", () => {
    // Two bounds, same input, different answers — a validator that consulted
    // the real clock could not produce both.
    expect(zNotFuture("2020-01-01").safeParse("2021-06-15").success).toBe(false);
    expect(zNotFuture("2030-01-01").safeParse("2021-06-15").success).toBe(true);
  });

  it("throws on a malformed `today` instead of validating against garbage", () => {
    // `today` comes from this application, not from the person filling in the
    // form, so a bad bound is a programming error — and comparing against one
    // would silently accept or reject everything.
    expect(() => zNotFuture("not-a-date")).toThrow();
    expect(() => zNotFuture("2026-08")).toThrow();
    expect(() => zNotFuture("")).toThrow();
  });
});
