/**
 * Offline unit tests for the pure query-parameter helpers.
 *
 * These run under `npm test` with no database — deliberately. They pin the
 * *exact* strings and bounds the Supabase-backed reads hand to PostgREST,
 * which is the half of the escaping contract a live query cannot show you:
 * the parity suite can prove an escaped pattern stops matching, but only this
 * file can prove *what* was sent.
 */
import { describe, expect, it } from "vitest";

import {
  assertRowLimit,
  containsPattern,
  effectiveDateBounds,
  escapeLikePattern,
  isEmptyRange,
} from "@/lib/data/filters";
import { isAppError } from "@/lib/errors";

describe("effectiveDateBounds", () => {
  it("passes explicit from/to through untouched", () => {
    expect(effectiveDateBounds({ from: "2026-08-16", to: "2026-08-19" })).toEqual({
      from: "2026-08-16",
      to: "2026-08-19",
    });
  });

  it("leaves an unbounded side absent rather than inventing a bound", () => {
    expect(effectiveDateBounds({ from: "2026-08-16" })).toEqual({ from: "2026-08-16" });
    expect(effectiveDateBounds({ to: "2026-08-19" })).toEqual({ to: "2026-08-19" });
    expect(effectiveDateBounds({})).toEqual({});
  });

  it("expands `month` into the equivalent monthStart/monthEnd range", () => {
    expect(effectiveDateBounds({ month: "2026-08" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("intersects `month` with an explicit `from` — the later lower bound wins", () => {
    expect(effectiveDateBounds({ month: "2026-08", from: "2026-08-16" })).toEqual({
      from: "2026-08-16",
      to: "2026-08-31",
    });
    // A `from` *earlier* than the month start must not widen the range.
    expect(effectiveDateBounds({ month: "2026-08", from: "2026-01-01" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("intersects `month` with an explicit `to` — the earlier upper bound wins", () => {
    expect(effectiveDateBounds({ month: "2026-08", to: "2026-08-14" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-14",
    });
    expect(effectiveDateBounds({ month: "2026-08", to: "2026-12-31" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });
});

describe("isEmptyRange", () => {
  it("detects a non-overlapping intersection", () => {
    expect(isEmptyRange(effectiveDateBounds({ month: "2026-08", to: "2026-01-01" }))).toBe(true);
  });

  it("treats a single-day range as non-empty (both bounds inclusive)", () => {
    expect(isEmptyRange({ from: "2026-08-19", to: "2026-08-19" })).toBe(false);
  });

  it("is false whenever either side is unbounded", () => {
    expect(isEmptyRange({ from: "2026-08-19" })).toBe(false);
    expect(isEmptyRange({ to: "2026-01-01" })).toBe(false);
    expect(isEmptyRange({})).toBe(false);
  });
});

describe("escapeLikePattern", () => {
  it("leaves ordinary text alone", () => {
    expect(escapeLikePattern("Whole Foods Market")).toBe("Whole Foods Market");
    expect(escapeLikePattern("Trader Joe's")).toBe("Trader Joe's");
    expect(escapeLikePattern("Electric & Water Co")).toBe("Electric & Water Co");
  });

  it("escapes the SQL LIKE wildcards", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("S_ell")).toBe("S\\_ell");
  });

  it("escapes PostgREST's `*` alias for `%`", () => {
    expect(escapeLikePattern("S*ell")).toBe("S\\*ell");
  });

  it("escapes a backslash exactly once — no double pass", () => {
    // A chain of replaces would turn "\" into "\\\\" here by re-escaping the
    // backslashes the previous pass introduced.
    expect(escapeLikePattern("\\")).toBe("\\\\");
    expect(escapeLikePattern("a\\%b")).toBe("a\\\\\\%b");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeLikePattern("%_%_")).toBe("\\%\\_\\%\\_");
  });

  it("never produces a dangling escape character", () => {
    for (const input of ["\\", "a\\", "%\\", "\\\\", "*\\"]) {
      const escaped = escapeLikePattern(input);
      const trailingBackslashes = /\\*$/.exec(escaped)![0].length;
      expect(trailingBackslashes % 2).toBe(0);
    }
  });
});

describe("containsPattern", () => {
  it("wraps escaped text so the only wildcards are the ones it added", () => {
    expect(containsPattern("whole")).toBe("%whole%");
    expect(containsPattern("S_ell")).toBe("%S\\_ell%");
    expect(containsPattern("T%t")).toBe("%T\\%t%");
    expect(containsPattern("S*ell")).toBe("%S\\*ell%");
  });

  it("produces a pattern with exactly two unescaped `%` — the delimiters", () => {
    for (const input of ["whole", "T%t", "S_ell", "a\\b", "*", "%%%"]) {
      const pattern = containsPattern(input);
      const unescaped = pattern.replace(/\\./g, "");
      expect(unescaped.split("%")).toHaveLength(3);
    }
  });
});

describe("assertRowLimit", () => {
  it("accepts zero and positive safe integers", () => {
    expect(() => assertRowLimit(0, "recent transactions")).not.toThrow();
    expect(() => assertRowLimit(5, "recent transactions")).not.toThrow();
    expect(() => assertRowLimit(Number.MAX_SAFE_INTEGER, "recent transactions")).not.toThrow();
  });

  it("rejects a negative, fractional, non-finite, or unsafe limit instead of coercing it", () => {
    for (const limit of [-1, 2.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertRowLimit(limit, "recent transactions")).toThrow();
    }
  });

  it("throws a data_integrity AppError naming the subject, never the value", () => {
    try {
      assertRowLimit(-1, "recent transactions");
      expect.unreachable("assertRowLimit should have thrown");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("data_integrity");
      expect((error as Error).message).toBe("Invalid limit value for recent transactions.");
    }
  });
});
