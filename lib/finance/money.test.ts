import { describe, expect, it } from "vitest";
import { toCents } from "@/lib/types";
import { percentage, sumCents } from "@/lib/finance/money";

describe("sumCents", () => {
  it("sums a list of Cents", () => {
    expect(sumCents([toCents(100), toCents(250), toCents(-50)])).toBe(300);
  });

  it("returns 0 for an empty list", () => {
    expect(sumCents([])).toBe(0);
  });
});

describe("percentage", () => {
  it("rounds to two decimal places", () => {
    // 1/3 = 33.333...% -> rounds to 33.33
    expect(percentage(1, 3)).toBe(33.33);
  });

  it("rounds .005 up", () => {
    // 4005 / 10000 = 40.05% exactly
    expect(percentage(4005, 10000)).toBe(40.05);
  });

  it("returns null for a zero denominator", () => {
    expect(percentage(500, 0)).toBeNull();
    expect(percentage(0, 0)).toBeNull();
  });

  it("handles negative numerator and denominator", () => {
    expect(percentage(-50, 200)).toBe(-25);
    expect(percentage(50, -200)).toBe(-25);
    expect(percentage(-50, -200)).toBe(25);
  });

  it("stays precise for large cents values where multiply-before-divide would lose precision", () => {
    // num * 10000 here (1e16) exceeds Number.MAX_SAFE_INTEGER (~9.007e15),
    // so a multiply-first implementation would silently round the
    // intermediate. Dividing first keeps the ratio small and precise.
    expect(percentage(1_000_000_000_000, 3_000_000_000_000)).toBe(33.33);
  });

  it("never returns NaN or Infinity", () => {
    expect(percentage(NaN, 100)).toBeNull();
    expect(percentage(Infinity, 100)).toBeNull();
  });
});
