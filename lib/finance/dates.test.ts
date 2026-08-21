import { describe, expect, it } from "vitest";
import {
  addMonths,
  daysBetween,
  listMonths,
  monthEnd,
  monthKey,
  monthLabel,
  monthStart,
  parseCalendarDate,
} from "@/lib/finance/dates";

describe("parseCalendarDate", () => {
  it("never shifts the day, regardless of host timezone", () => {
    const d = parseCalendarDate("2026-08-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // 0-indexed
    expect(d.getDate()).toBe(1);
  });
});

describe("daysBetween", () => {
  it("is 0 for the same date", () => {
    expect(daysBetween("2026-08-20", "2026-08-20")).toBe(0);
  });

  it("is negative when `to` precedes `from`", () => {
    expect(daysBetween("2026-08-20", "2026-08-13")).toBe(-7);
  });

  it("is timezone-safe across a DST transition (Mar 8 2026, US spring-forward)", () => {
    // Computed via Date.UTC, so this is exact regardless of the host's
    // local timezone/DST rules — a local-midnight-subtraction
    // implementation could be off by one across this boundary.
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });

  it("handles a leap day correctly", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
  });
});

describe("monthKey", () => {
  it("extracts YYYY-MM", () => {
    expect(monthKey("2026-08-20")).toBe("2026-08");
  });
});

describe("monthLabel", () => {
  it("formats a month key as a short label", () => {
    expect(monthLabel("2026-08")).toBe("Aug 2026");
  });
});

describe("addMonths", () => {
  it("adds within a year", () => {
    expect(addMonths("2026-03", 2)).toBe("2026-05");
  });

  it("rolls over a year boundary forward", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });

  it("rolls over a year boundary backward", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
});

describe("listMonths", () => {
  it("returns an inclusive range", () => {
    expect(listMonths("2026-06", "2026-08")).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("returns a single month when from === to", () => {
    expect(listMonths("2026-08", "2026-08")).toEqual(["2026-08"]);
  });
});

describe("monthStart", () => {
  it("returns the first day of the month", () => {
    expect(monthStart("2026-08")).toBe("2026-08-01");
  });

  it("zero-pads a single-digit month", () => {
    expect(monthStart("2026-03")).toBe("2026-03-01");
  });
});

describe("monthEnd", () => {
  it("returns the 31st for a 31-day month", () => {
    expect(monthEnd("2026-08")).toBe("2026-08-31");
  });

  it("returns the 30th for a 30-day month", () => {
    expect(monthEnd("2026-04")).toBe("2026-04-30");
  });

  it("returns Feb 28 in a non-leap year", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
  });

  it("returns Feb 29 in a leap year", () => {
    expect(monthEnd("2024-02")).toBe("2024-02-29");
  });

  it("handles the December year-end correctly", () => {
    expect(monthEnd("2026-12")).toBe("2026-12-31");
  });
});
