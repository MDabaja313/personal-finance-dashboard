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

/**
 * The plain decimal string a money `<input>` should start with, e.g.
 * "-1284.50" — no currency symbol, no grouping, always two decimal places.
 *
 * Integer division and a padded remainder, never `cents / 100`: this value is
 * about to be *re-parsed* by `parseMoneyToCents`, and a float round-trip is
 * exactly the silent off-by-a-cent that module exists to prevent. The two
 * formatters above may divide because their output is only ever read by a
 * person.
 *
 * Here rather than in a component, so "convert `Cents` to a decimal" keeps the
 * single home this module's first comment claims for it.
 */
export function formatCentsForInput(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  return `${sign}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

/** Explicit sign prefix, e.g. "+$320.00" / "-$215.00" / "$0.00". */
export function formatCentsSigned(cents: Cents): string {
  const magnitude = currencyFormatter.format(Math.abs(cents) / 100);
  if (cents > 0) return `+${magnitude}`;
  if (cents < 0) return `-${magnitude}`;
  return magnitude;
}
