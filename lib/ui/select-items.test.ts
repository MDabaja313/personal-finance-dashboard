import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { optionItems, selectItems } from "@/lib/ui/select-items";

/**
 * Two halves, because the helper alone would not have caught the bug it exists
 * to fix.
 *
 * 1. **The function.** A value → label map, with the sentinel handling every
 *    "Uncategorized" / "All" / "No account" option in this application needs.
 * 2. **A source scan over `components/**`.** Every `<Select` must be given an
 *    `items` prop, and no `<SelectItem value=` may be bound to a display name.
 *    That is the actual regression guard: Base UI's `<Select.Value>` renders
 *    `String(value)` when the Root has no `items`, so a selector whose values
 *    are database ids shows a raw UUID in its own trigger — visible only when
 *    the popup is closed, which is why it survived review the first time.
 *
 * The scan lives here rather than in a component test because this repository
 * has no component test runner: `npm test` is scoped to `lib/**​/*.test.ts`. The
 * precedent is `lib/write-posture.test.ts`, which checks its own boundaries the
 * same way.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

// ============================================================
// Half 1 — the helper
// ============================================================

describe("selectItems", () => {
  it("maps each value to its label", () => {
    expect(
      selectItems([
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ])
    ).toEqual({ a: "Alpha", b: "Beta" });
  });

  it("returns an empty map for an empty list", () => {
    // Not a special case: a selector with no options has no label to resolve,
    // and `<Select.Value>` falls back to its placeholder.
    expect(selectItems([])).toEqual({});
  });

  it("keeps a UUID key verbatim — the value is what gets submitted", () => {
    const id = "8b4a18d2-4fc7-4be5-9c3a-000000000001";
    const items = selectItems([{ value: id, label: "Groceries" }]);

    expect(Object.keys(items)).toEqual([id]);
    expect(items[id]).toBe("Groceries");
  });

  it("lets a later entry win on a duplicate value", () => {
    expect(
      selectItems([
        { value: "a", label: "First" },
        { value: "a", label: "Second" },
      ])
    ).toEqual({ a: "Second" });
  });
});

describe("optionItems", () => {
  const rows = [
    { id: "8b4a18d2-4fc7-4be5-9c3a-000000000001", name: "Groceries" },
    { id: "8b4a18d2-4fc7-4be5-9c3a-000000000002", name: "Rent" },
  ];

  it("maps owned rows from id to name", () => {
    expect(optionItems(rows)).toEqual({
      "8b4a18d2-4fc7-4be5-9c3a-000000000001": "Groceries",
      "8b4a18d2-4fc7-4be5-9c3a-000000000002": "Rent",
    });
  });

  it("prepends a sentinel option without disturbing the rows", () => {
    const items = optionItems(rows, { value: "none", label: "Uncategorized" });

    expect(items.none).toBe("Uncategorized");
    expect(items["8b4a18d2-4fc7-4be5-9c3a-000000000001"]).toBe("Groceries");
    expect(Object.keys(items)).toHaveLength(3);
  });

  it("produces just the sentinel when there are no rows", () => {
    expect(optionItems([], { value: "all", label: "All accounts" })).toEqual({
      all: "All accounts",
    });
  });

  it("maps every id in the list — nothing is dropped", () => {
    const items = optionItems(rows);
    for (const row of rows) expect(items[row.id]).toBe(row.name);
  });
});

// ============================================================
// Half 2 — every Select in components/** resolves its label
// ============================================================

const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const componentFiles = walk(join(ROOT, "components"))
  .map((path) => ({
    repoPath: relative(ROOT, path).split("\\").join("/"),
    code: readFileSync(path, "utf8"),
  }))
  // `components/ui/select.tsx` is the generated shadcn primitive — it defines
  // the wrappers rather than using them, and it is not hand-edited.
  .filter(({ repoPath }) => repoPath !== "components/ui/select.tsx");

/** Every `<Select …>` opening tag in one file, with its attribute text. */
function selectOpeningTags(code: string): string[] {
  return [...code.matchAll(/<Select(?=[\s>])[^>]*>/g)].map((match) => match[0]);
}

describe("every Select in components/** renders a human-readable label", () => {
  it("finds Select usages at all — the scan is not vacuous", () => {
    const total = componentFiles.reduce(
      (count, file) => count + selectOpeningTags(file.code).length,
      0
    );
    // A positive control. If the regex ever stopped matching, the assertion
    // below would pass over an empty set forever.
    expect(total).toBeGreaterThan(10);
  });

  it("gives every Select root an `items` map", () => {
    // Without it, Base UI's <Select.Value> renders String(value): a raw UUID
    // for the account/category/transaction pickers, and the wire label
    // ("expense", "credit_card_payment") for the enum-backed ones.
    const offenders = componentFiles.flatMap(({ repoPath, code }) =>
      selectOpeningTags(code)
        .filter((tag) => !/\bitems=/.test(tag))
        .map((tag) => `${repoPath}: ${tag.replace(/\s+/g, " ")}`)
    );

    expect(offenders).toEqual([]);
  });

  it("never binds a SelectItem's value to a display name", () => {
    // The other half of the contract: the label is what changed, the stored
    // value is not. A `value={category.name}` would render identically and
    // submit the wrong thing to a UUID column.
    const offenders = componentFiles.flatMap(({ repoPath, code }) =>
      [...code.matchAll(/<SelectItem[^>]*\bvalue=\{([^}]*)\}/g)]
        .map((match) => match[1].trim())
        .filter((expression) => /\.(name|label|title)\b/.test(expression))
        .map((expression) => `${repoPath}: value={${expression}}`)
    );

    expect(offenders).toEqual([]);
  });

  it("builds every items map through lib/ui/select-items", () => {
    // A hand-rolled object literal would work today and drift tomorrow — the
    // sentinel handling in particular is easy to get subtly wrong. Any file
    // that renders a Select must import the helper.
    const offenders = componentFiles
      .filter(({ code }) => selectOpeningTags(code).length > 0)
      .filter(({ code }) => !/@\/lib\/ui\/select-items/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });
});
