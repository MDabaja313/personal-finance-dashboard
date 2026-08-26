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
  MAX_TRANSACTION_LIMIT,
  assertRowLimit,
  containsPattern,
  effectiveDateBounds,
  escapeLikePattern,
  isEmptyRange,
  iterateFetchWindows,
  planFetchWindows,
  resolvePageRange,
  resolveRevealPage,
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

describe("resolvePageRange", () => {
  function caught(input: Parameters<typeof resolvePageRange>[0]): { code: string; message: string } {
    try {
      resolvePageRange(input, "transactions");
    } catch (error) {
      if (!isAppError(error)) throw new Error(`Expected an AppError, received: ${String(error)}`);
      return { code: error.code, message: error.message };
    }
    throw new Error("Expected resolvePageRange to throw, but it returned.");
  }

  it("returns undefined when no pagination is requested — the full-query contract", () => {
    expect(resolvePageRange({}, "transactions")).toBeUndefined();
    // offset 0 with no limit is not pagination either: it is the same query.
    expect(resolvePageRange({ offset: 0 }, "transactions")).toBeUndefined();
  });

  it("defaults the offset to 0 when only a limit is given", () => {
    expect(resolvePageRange({ limit: 25 }, "transactions")).toEqual({ from: 0, to: 24 });
    expect(resolvePageRange({ limit: 1 }, "transactions")).toEqual({ from: 0, to: 0 });
  });

  it("produces an inclusive range — PostgREST's .range() is inclusive on both ends", () => {
    expect(resolvePageRange({ offset: 0, limit: 10 }, "transactions")).toEqual({ from: 0, to: 9 });
    expect(resolvePageRange({ offset: 10, limit: 10 }, "transactions")).toEqual({ from: 10, to: 19 });
    expect(resolvePageRange({ offset: 7, limit: 3 }, "transactions")).toEqual({ from: 7, to: 9 });
  });

  it("accepts a limit exactly at the maximum and rejects one above it", () => {
    expect(resolvePageRange({ limit: MAX_TRANSACTION_LIMIT }, "transactions")).toEqual({
      from: 0,
      to: MAX_TRANSACTION_LIMIT - 1,
    });

    const error = caught({ limit: MAX_TRANSACTION_LIMIT + 1 });
    expect(error.code).toBe("data_integrity");
    expect(error.message).toBe("Limit exceeds the maximum for transactions.");
  });

  it("rejects a zero, negative, fractional, or non-finite limit instead of coercing it", () => {
    for (const limit of [0, -1, -25, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const error = caught({ limit });
      expect(error.code).toBe("data_integrity");
      expect(error.message).toBe("Invalid limit value for transactions.");
    }
  });

  it("rejects a negative, fractional, or non-finite offset instead of coercing it", () => {
    for (const offset of [-1, -25, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const error = caught({ offset, limit: 25 });
      expect(error.code).toBe("data_integrity");
      expect(error.message).toBe("Invalid offset value for transactions.");
    }
  });

  it("rejects an offset above zero with no limit rather than inventing a ceiling", () => {
    const error = caught({ offset: 25 });
    expect(error.code).toBe("data_integrity");
    expect(error.message).toBe("A pagination offset requires a limit for transactions.");
  });

  it("validates the offset before the limit, so a bad offset is reported as one", () => {
    expect(caught({ offset: -1, limit: 0 }).message).toBe("Invalid offset value for transactions.");
  });

  it("never names the offending value in the message", () => {
    expect(caught({ limit: 99999 }).message).not.toContain("99999");
    expect(caught({ offset: -7, limit: 25 }).message).not.toContain("7");
  });
});

/**
 * The window planner is the reason `MAX_TRANSACTION_LIMIT` bounds a *query*
 * without bounding *history*. It is tested here, at sizes far past anything
 * the 104-row seed can reach, precisely so the ceiling-on-history regression
 * cannot come back unnoticed just because the fixture data is small.
 */
describe("planFetchWindows", () => {
  const MAX = MAX_TRANSACTION_LIMIT;

  it("returns a single bounded window for anything up to the maximum", () => {
    expect(planFetchWindows(1)).toEqual([{ offset: 0, limit: 1 }]);
    expect(planFetchWindows(26)).toEqual([{ offset: 0, limit: 26 }]);
    expect(planFetchWindows(MAX)).toEqual([{ offset: 0, limit: MAX }]);
  });

  it("splits one row past the maximum into two windows", () => {
    expect(planFetchWindows(MAX + 1)).toEqual([
      { offset: 0, limit: MAX },
      { offset: MAX, limit: 1 },
    ]);
  });

  it("plans the worked example — 626 rows becomes 500 + 126", () => {
    expect(planFetchWindows(626)).toEqual([
      { offset: 0, limit: 500 },
      { offset: 500, limit: 126 },
    ]);
  });

  it("plans three bounded windows for 1001 rows", () => {
    expect(planFetchWindows(1001)).toEqual([
      { offset: 0, limit: 500 },
      { offset: 500, limit: 500 },
      { offset: 1000, limit: 1 },
    ]);
  });

  it("keeps every window within MAX_TRANSACTION_LIMIT, at every size", () => {
    for (const need of [1, 25, 499, 500, 501, 626, 1000, 1001, 5000, 50_001]) {
      for (const window of planFetchWindows(need)) {
        expect(window.limit).toBeGreaterThan(0);
        expect(window.limit).toBeLessThanOrEqual(MAX);
        expect(Number.isSafeInteger(window.offset)).toBe(true);
        expect(window.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("produces contiguous windows — no gap and no overlap at any boundary", () => {
    for (const need of [1, 500, 501, 626, 1000, 1001, 2500, 50_001]) {
      const windows = planFetchWindows(need);
      let expectedOffset = 0;
      for (const window of windows) {
        // A gap would skip rows; an overlap would render one twice.
        expect(window.offset).toBe(expectedOffset);
        expectedOffset = window.offset + window.limit;
      }
      // And the plan ends exactly at the requested row count.
      expect(expectedOffset).toBe(need);
    }
  });

  it("has total capacity exactly equal to the requested need — never over-fetches", () => {
    for (const need of [1, 26, 500, 501, 626, 1001, 12_345]) {
      const total = planFetchWindows(need).reduce((sum, w) => sum + w.limit, 0);
      expect(total).toBe(need);
    }
  });

  it("uses the fewest windows that can cover the need", () => {
    for (const need of [1, 500, 501, 1000, 1001, 12_345]) {
      expect(planFetchWindows(need)).toHaveLength(Math.ceil(need / MAX));
    }
  });

  it("emits windows the DAL's own pagination validator accepts", () => {
    // Closing the loop: the planner's output has to survive the same
    // validation the DAL applies to it, or a deep page would fail at runtime
    // while passing here.
    for (const window of planFetchWindows(1001)) {
      expect(resolvePageRange(window, "transactions")).toEqual({
        from: window.offset,
        to: window.offset + window.limit - 1,
      });
    }
  });

  it("honors a smaller window size, so the split logic is provable without 500 rows", () => {
    expect(planFetchWindows(7, 3)).toEqual([
      { offset: 0, limit: 3 },
      { offset: 3, limit: 3 },
      { offset: 6, limit: 1 },
    ]);
    expect(planFetchWindows(6, 3)).toEqual([
      { offset: 0, limit: 3 },
      { offset: 3, limit: 3 },
    ]);
  });

  it("rejects a zero, negative, fractional, or non-finite need", () => {
    for (const need of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      try {
        planFetchWindows(need);
        expect.unreachable("planFetchWindows should have thrown");
      } catch (error) {
        expect(isAppError(error)).toBe(true);
        expect((error as { code: string }).code).toBe("data_integrity");
      }
    }
  });

  it("rejects an invalid window size rather than looping forever", () => {
    for (const maxWindow of [0, -1, 2.5, NaN]) {
      expect(() => planFetchWindows(10, maxWindow)).toThrow();
    }
  });

  it("is lazy — a huge need costs one window, not a materialized plan", () => {
    // The production path pulls windows one at a time and stops at the first
    // short result, so a very deep page must not build its plan up front.
    const windows = iterateFetchWindows(Number.MAX_SAFE_INTEGER);
    expect(windows.next().value).toEqual({ offset: 0, limit: MAX });
    expect(windows.next().value).toEqual({ offset: MAX, limit: MAX });
    windows.return(undefined);
  });
});

/**
 * The reveal resolver is where the "how deep can history go" question is
 * settled. These tests exist mainly as a regression fence: earlier drafts of
 * this page carried a fixed maximum (475 rows, then 50,000) that silently made
 * older history unreachable. There is no such ceiling now, and this block is
 * what would fail if one came back.
 */
describe("resolveRevealPage", () => {
  it("resolves an ordinary page into its cumulative reveal", () => {
    expect(resolveRevealPage("1", 25)).toEqual({ page: 1, revealed: 25, need: 26 });
    expect(resolveRevealPage("2", 25)).toEqual({ page: 2, revealed: 50, need: 51 });
    expect(resolveRevealPage("5", 25)).toEqual({ page: 5, revealed: 125, need: 126 });
  });

  it("imposes NO page or reveal ceiling — deep pages are honored exactly", () => {
    // The two ceilings this page used to have, and one far past both.
    expect(resolveRevealPage("20", 25)).toEqual({ page: 20, revealed: 500, need: 501 });
    expect(resolveRevealPage("2001", 25)).toEqual({ page: 2001, revealed: 50_025, need: 50_026 });
    expect(resolveRevealPage("99999", 25)).toEqual({
      page: 99_999,
      revealed: 2_499_975,
      need: 2_499_976,
    });
    expect(resolveRevealPage("100000000", 25).page).toBe(100_000_000);
  });

  it("accepts every page whose reveal arithmetic stays safe", () => {
    const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / 25) - 1;
    const plan = resolveRevealPage(String(maxPage), 25);
    expect(plan.page).toBe(maxPage);
    expect(Number.isSafeInteger(plan.revealed)).toBe(true);
    expect(Number.isSafeInteger(plan.need)).toBe(true);
  });

  it("falls back to page 1 for malformed or non-positive input", () => {
    const firstPage = { page: 1, revealed: 25, need: 26 };
    for (const raw of [undefined, "", "abc", "-1", "0", "1.5", "1e5", " 2", "2 ", "+2", "٢"]) {
      expect(resolveRevealPage(raw, 25)).toEqual(firstPage);
    }
  });

  it("falls back to page 1 when the reveal or probe would leave the safe-integer range", () => {
    const firstPage = { page: 1, revealed: 25, need: 26 };
    // `pageSize * page` overflows.
    expect(resolveRevealPage(String(Number.MAX_SAFE_INTEGER), 25)).toEqual(firstPage);
    expect(resolveRevealPage("999999999999999999999", 25)).toEqual(firstPage);
    // The page itself is already past the safe range.
    expect(resolveRevealPage("9007199254740993", 25)).toEqual(firstPage);
    // `revealed` is exactly MAX_SAFE_INTEGER, so the probe row overflows.
    expect(resolveRevealPage(String(Number.MAX_SAFE_INTEGER), 1)).toEqual({
      page: 1,
      revealed: 1,
      need: 2,
    });
  });

  it("never returns a page, reveal, or need outside the safe-integer range", () => {
    for (const raw of [undefined, "abc", "1", "2001", "99999", "9007199254740993", "1e400"]) {
      const plan = resolveRevealPage(raw, 25);
      expect(Number.isSafeInteger(plan.page)).toBe(true);
      expect(Number.isSafeInteger(plan.revealed)).toBe(true);
      expect(Number.isSafeInteger(plan.need)).toBe(true);
      expect(plan.page).toBeGreaterThanOrEqual(1);
      expect(plan.need).toBe(plan.revealed + 1);
    }
  });

  it("hands the planner a need every window of which is a bounded query", () => {
    // The end-to-end invariant: whatever page survives resolution, the plan it
    // implies never asks the DAL for more than MAX_TRANSACTION_LIMIT at once.
    for (const raw of ["1", "2", "20", "21", "2001"]) {
      const { need } = resolveRevealPage(raw, 25);
      const windows = planFetchWindows(need);
      let expectedOffset = 0;
      for (const window of windows) {
        expect(window.limit).toBeLessThanOrEqual(MAX_TRANSACTION_LIMIT);
        expect(window.offset).toBe(expectedOffset);
        expectedOffset = window.offset + window.limit;
      }
      expect(expectedOffset).toBe(need);
    }
  });

  it("rejects an invalid page size — a developer bug, not a fallback", () => {
    for (const pageSize of [0, -25, 2.5, NaN]) {
      expect(() => resolveRevealPage("1", pageSize)).toThrow();
    }
  });
});
