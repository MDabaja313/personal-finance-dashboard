import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_TYPES,
  BILL_FREQUENCIES,
  BILL_OCCURRENCE_STATUSES,
  CATEGORY_KINDS,
  MOVEMENT_KINDS,
  TRANSACTION_KINDS,
} from "@/lib/types/enums";

/**
 * Drift guard: every array in `lib/types/enums.ts` is checked against the
 * `create type ... as enum` statements in the migration that actually creates
 * them. The migration is the authority — these arrays are its mirror — so a
 * label added, removed, or reordered in SQL without a matching TypeScript
 * change fails here rather than at runtime against production data.
 *
 * Order is asserted, not just membership: a Postgres enum sorts by declaration
 * order, and these arrays double as the canonical sort order for their labels.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "20260822150002_enums_and_tables.sql");

const sql = readFileSync(MIGRATION, "utf8");

/** The label list of one `create type public.<name> as enum (...)` statement. */
function enumLabels(name: string): string[] {
  const statement = new RegExp(`create type public\.${name} as enum\s*\(([^)]*)\)`, "i").exec(sql);
  if (!statement) throw new Error(`No 'create type public.${name} as enum' in ${MIGRATION}`);
  return [...statement[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

describe("DB enum mirrors", () => {
  it.each([
    ["account_type", ACCOUNT_TYPES],
    ["category_kind", CATEGORY_KINDS],
    ["transaction_kind", TRANSACTION_KINDS],
    ["movement_kind", MOVEMENT_KINDS],
    ["bill_frequency", BILL_FREQUENCIES],
    ["bill_occurrence_status", BILL_OCCURRENCE_STATUSES],
  ])("%s matches the migration exactly, in declaration order", (name, labels) => {
    expect([...labels]).toEqual(enumLabels(name));
  });

  it("finds a non-empty label list for every enum it checks", () => {
    // Guards the helper itself: a regex that silently matched nothing would
    // make every assertion above pass vacuously as [] === [].
    expect(enumLabels("account_type").length).toBeGreaterThan(0);
    expect(enumLabels("bill_occurrence_status").length).toBeGreaterThan(0);
  });

  it("keeps movement kinds a strict subset of transaction kinds", () => {
    // The schema comment calls movement_kind "deliberately narrower than
    // transaction_kind"; that relationship is what lets a movement leg be
    // stored in `transactions` at all.
    for (const kind of MOVEMENT_KINDS) {
      expect(TRANSACTION_KINDS).toContain(kind);
    }
    expect(MOVEMENT_KINDS.length).toBeLessThan(TRANSACTION_KINDS.length);
  });

  it("has no `adjustment` transaction kind yet", () => {
    // The balance-adjustment/reconciliation mechanism is a recorded future
    // prerequisite (DEVELOPMENT_PLAN.md), not a Phase 7 CP1 deliverable. If
    // it is ever added to the enum, it must be added deliberately — with the
    // sign rules, the CHECK constraint, and the finance-layer handling that
    // go with it — not by drifting into this list.
    expect(TRANSACTION_KINDS).not.toContain("adjustment");
    expect(sql).not.toMatch(/'adjustment'/);
  });
});
