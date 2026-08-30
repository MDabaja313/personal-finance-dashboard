/**
 * The `items` map a Base UI `<Select.Root>` needs in order to render a *label*
 * in its trigger rather than the raw value.
 *
 * ## The bug this exists to prevent
 *
 * `@base-ui/react`'s `<Select.Value>` does not read the selected
 * `<Select.Item>`'s children the way Radix's does. It resolves the label from
 * the Root's `items` prop, and when that prop is absent it falls back to
 * `String(value)` — so a control whose values are database ids renders a raw
 * UUID in its own trigger:
 *
 *     8b4a18d2-4fc7-4be5-…
 *
 * Every UUID-backed selector in this application had that shape, and the
 * enum-backed ones rendered their wire labels ("expense", "credit_card_payment")
 * instead of their display text. The options list looked correct because the
 * popup renders `<Select.Item>` children directly; only the closed trigger was
 * wrong, which is why it survived review.
 *
 * The fix is a value → label map on the Root. **The stored value is untouched**:
 * every `<Select.Item value>` and every submitted `FormData` entry is still the
 * id or the enum label the database expects. This module only supplies the text
 * a person reads.
 *
 * ## Why it lives in `lib/` rather than beside the components
 *
 * So it can be unit tested. `npm test` is scoped to `lib/**​/*.test.ts` and this
 * repository has no component test runner, so a helper defined in
 * `components/**` would be a rendering rule with nothing checking it — which is
 * exactly how the original bug got in. `lib/ui/select-items.test.ts` covers the
 * function and scans every `<Select` in `components/**` for the prop.
 *
 * Pure: no React, no DAL, no clock. It builds a plain object.
 */

/** One selectable option: the value that is submitted, and the text that is shown. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * `[{ value, label }, …]` → the `Record<string, string>` Base UI's
 * `<Select.Root items>` accepts.
 *
 * Later entries win on a duplicate value, which is plain object semantics and
 * is stated rather than guarded: a duplicated value in one selector is a bug in
 * the caller's option list, and throwing here would turn a cosmetic mistake
 * into a crashed page.
 *
 * An empty list produces an empty map, which is correct and not a special case:
 * a selector with no options has no label to resolve, and `<Select.Value>` then
 * renders its placeholder.
 */
export function selectItems(options: readonly SelectOption[]): Record<string, string> {
  const items: Record<string, string> = {};
  for (const option of options) items[option.value] = option.label;
  return items;
}

/**
 * The common case: a list of owned rows with an `id` and a display name.
 *
 * `sentinel` prepends a non-id entry — the "Uncategorized", "All", "No linked
 * transaction" options whose value is a literal rather than a row id. It is a
 * parameter rather than something callers merge in afterwards so the sentinel
 * and the rows are described in one expression, and so nothing has to remember
 * that the sentinel must come first to be overwritten by a colliding row (it
 * cannot collide — a sentinel is never a UUID — but the ordering is the honest
 * one).
 */
export function optionItems(
  rows: readonly { readonly id: string; readonly name: string }[],
  sentinel?: SelectOption
): Record<string, string> {
  return selectItems([
    ...(sentinel ? [sentinel] : []),
    ...rows.map((row) => ({ value: row.id, label: row.name })),
  ]);
}
