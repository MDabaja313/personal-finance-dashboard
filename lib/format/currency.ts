import type { Cents } from "@/lib/types";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** The only place a `Cents` value is converted to a decimal amount. */
export function formatCents(cents: Cents): string {
  return currencyFormatter.format(cents / 100);
}

/** Compact form for tight spaces (chart axes/ticks), e.g. "$85K". */
export function formatCentsCompact(cents: Cents): string {
  return compactCurrencyFormatter.format(cents / 100);
}

/** Explicit sign prefix, e.g. "+$320.00" / "-$215.00" / "$0.00". */
export function formatCentsSigned(cents: Cents): string {
  const magnitude = currencyFormatter.format(Math.abs(cents) / 100);
  if (cents > 0) return `+${magnitude}`;
  if (cents < 0) return `-${magnitude}`;
  return magnitude;
}
