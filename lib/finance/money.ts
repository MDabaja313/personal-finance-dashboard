import { toCents, type Cents } from "@/lib/types";

export function sumCents(values: readonly Cents[]): Cents {
  return toCents(values.reduce((total, value) => total + value, 0));
}

/**
 * A display percentage — never money. Divides first, then scales, so an
 * individually safe `num`/`den` pair can never overflow the intermediate
 * (the tempting `(num * 10000) / den` multiplies before dividing, which can
 * exceed Number.isSafeInteger before the division ever runs).
 *
 * Returns null for a zero denominator or a non-finite result — render both
 * as "—", never NaN/Infinity. The float result must never re-enter money
 * arithmetic.
 */
export function percentage(num: number, den: number): number | null {
  if (den === 0) return null;
  const pct = Math.round((num / den) * 10000) / 100;
  return Number.isFinite(pct) ? pct : null;
}
