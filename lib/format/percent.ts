/** Formats the output of lib/finance's `percentage()`. null renders as "—". */
export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value}%`;
}
