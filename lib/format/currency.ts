import type { Cents } from "@/lib/types";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** The only place a `Cents` value is converted to a decimal amount. */
export function formatCents(cents: Cents): string {
  return currencyFormatter.format(cents / 100);
}
