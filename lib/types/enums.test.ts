import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_TYPES,
  BILL_FREQUENCIES,
  BILL_OCCURRENCE_STATUSES,
  BILL_PAYMENT_ORIGINS,
  CATEGORY_KINDS,
  MOVEMENT_KINDS,
  ORDINARY_TRANSACTION_KINDS,
  TRANSACTION_KINDS,
  categoryKindFor,
  isMovementKind,
  isOrdinaryTransactionKind,
  signedAmountFor,
} from "@/lib/types/enums";
import { toCents } from "@/lib/types";

/**
 * Drift guard: every array in `lib/types/enums.ts` is checked against the SQL
 * that actually defines it. The migrations are the authority — these arrays are
 * their mirror — so a label added, removed, or reordered in SQL without a
 * matching TypeScript change fails here rather than at runtime against
 * production data.
 *
 * Order is asserted, not just membership: a Postgres enum sorts by declaration
 * order, and these arrays double as the canonical sort order for their labels.
 *
 * ## Why this reads the whole migrations directory
 *
 * Phase 7 CP3 added `adjustment` to `transaction_kind` with a separate
 * `alter type ... add value` migration — the only way to add a label and then
 * use it, since a label is unusable in the transaction that adds it. Reading
 * only the `create type` migration would have kept passing while the database's
 * actual enum had grown a member, which is precisely the drift this file
 * exists to catch. So labels are reconstructed the way Postgres builds them:
 * the `create type` list first, then each later `ADD VALUE` appended in
 * migration order.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Every migration, in the lexicographic order the Supabase CLI applies them. */
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

const allSql = migrations.map((migration) => migration.sql).join("\n");

/**
 * The label list of `public.<name>`, as the database would end up holding it.
 *
 * `ADD VALUE ... BEFORE/AFTER` is deliberately not supported: no migration uses
 * it, and silently ignoring the positioning clause would produce a label list
 * in the wrong order — the exact failure this helper is supposed to detect. It
 * throws instead.
 */
function enumLabels(name: string): string[] {
  const created = new RegExp(`create type public\\.${name} as enum\\s*\\(([^)]*)\\)`, "i").exec(allSql);
  if (!created) throw new Error(`No 'create type public.${name} as enum' in ${MIGRATIONS_DIR}`);

  const labels = [...created[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);

  const addValue = new RegExp(
    `alter type public\\.${name}\\s+add value\\s+(if not exists\\s+)?'([^']*)'([^;]*)`,
    "gi"
  );
  for (const { name: migrationName, sql } of migrations) {
    for (const match of sql.matchAll(addValue)) {
      if (/\b(before|after)\b/i.test(match[3])) {
        throw new Error(
          `${migrationName} positions a ${name} label with BEFORE/AFTER; enumLabels cannot order that.`
        );
      }
      labels.push(match[2]);
    }
  }

  return labels;
}

describe("DB enum mirrors", () => {
  it.each([
    ["account_type", ACCOUNT_TYPES],
    ["category_kind", CATEGORY_KINDS],
    ["transaction_kind", TRANSACTION_KINDS],
    ["movement_kind", MOVEMENT_KINDS],
    ["bill_frequency", BILL_FREQUENCIES],
    ["bill_occurrence_status", BILL_OCCURRENCE_STATUSES],
    ["bill_payment_origin", BILL_PAYMENT_ORIGINS],
  ])("%s matches the migrations exactly, in declaration order", (name, labels) => {
    expect([...labels]).toEqual(enumLabels(name));
  });

  it("finds a non-empty label list for every enum it checks", () => {
    // Guards the helper itself: a regex that silently matched nothing would
    // make every assertion above pass vacuously as [] === [].
    expect(enumLabels("account_type").length).toBeGreaterThan(0);
    expect(enumLabels("bill_occurrence_status").length).toBeGreaterThan(0);
  });

  it("picks up a label added by a later `alter type ... add value`", () => {
    // The specific mechanism CP3 introduced. Asserted directly so a helper that
    // regressed to reading only the `create type` statement fails here with a
    // clear reason, rather than as a confusing mismatch above.
    expect(enumLabels("transaction_kind")).toContain("adjustment");
    expect(enumLabels("transaction_kind").at(-1)).toBe("adjustment");
    expect(allSql).toMatch(/alter type public\.transaction_kind\s+add value\s+'adjustment'/i);
  });

  it("has no writable subset for bill_payment_origin — the empty set is the point", () => {
    // Every other enum here has a companion array naming the labels a person
    // may write (`ORDINARY_TRANSACTION_KINDS`, `BILL_OCCURRENCE_OUTCOMES`).
    // This one does not, and must not: `public.settle_bill_occurrence` chooses
    // the value in SQL, and `guard_bill_occurrence_transition()` refuses
    // 'generated' for any transaction that did not come into existence in the
    // same database transaction. A writable-subset array would be the first
    // step toward a form field for it.
    expect([...BILL_PAYMENT_ORIGINS]).toEqual(["linked", "generated"]);
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
});

describe("ordinary transaction kinds", () => {
  it("is exactly income/expense/refund — the writable subset", () => {
    expect([...ORDINARY_TRANSACTION_KINDS]).toEqual(["income", "expense", "refund"]);
  });

  it("excludes both movement kinds and adjustment", () => {
    // The whole point of the list. A movement leg cannot be created alone
    // (validate_movement() would reject the one-legged movement at COMMIT), and
    // an adjustment is a CP5 reconciliation outcome the database refuses to let
    // an UPDATE produce.
    for (const excluded of [...MOVEMENT_KINDS, "adjustment"] as const) {
      expect(ORDINARY_TRANSACTION_KINDS as readonly string[]).not.toContain(excluded);
      expect(isOrdinaryTransactionKind(excluded)).toBe(false);
    }
  });

  it("is a strict subset of the full kind list, and every member is a real kind", () => {
    for (const kind of ORDINARY_TRANSACTION_KINDS) expect(TRANSACTION_KINDS).toContain(kind);
    expect(ORDINARY_TRANSACTION_KINDS.length).toBeLessThan(TRANSACTION_KINDS.length);
  });

  it("recognizes each ordinary kind and rejects unknown text", () => {
    for (const kind of ORDINARY_TRANSACTION_KINDS) expect(isOrdinaryTransactionKind(kind)).toBe(true);
    expect(isOrdinaryTransactionKind("")).toBe(false);
    expect(isOrdinaryTransactionKind("Expense")).toBe(false);
    expect(isOrdinaryTransactionKind("not_a_kind")).toBe(false);
  });
});

describe("isMovementKind", () => {
  it("is true for exactly the two paired kinds", () => {
    expect(isMovementKind("transfer")).toBe(true);
    expect(isMovementKind("credit_card_payment")).toBe(true);
    expect(isMovementKind("income")).toBe(false);
    expect(isMovementKind("expense")).toBe(false);
    expect(isMovementKind("refund")).toBe(false);
    // An adjustment is not a movement. It moves a balance without a
    // counterparty leg, so it needs its own handling everywhere, not the
    // movement branch.
    expect(isMovementKind("adjustment")).toBe(false);
  });
});

describe("categoryKindFor", () => {
  it("maps income to an income category and expense/refund to an expense one", () => {
    expect(categoryKindFor("income")).toBe("income");
    expect(categoryKindFor("expense")).toBe("expense");
    // A refund reduces the spend of the category it refunds — it is not
    // income, so it is filed against the same expense category.
    expect(categoryKindFor("refund")).toBe("expense");
  });

  it("only ever names a real category kind", () => {
    for (const kind of ORDINARY_TRANSACTION_KINDS) {
      expect(CATEGORY_KINDS).toContain(categoryKindFor(kind));
    }
  });
});

describe("signedAmountFor", () => {
  it("negates an expense and leaves income/refund positive", () => {
    expect(signedAmountFor("expense", toCents(12_34))).toBe(-1234);
    expect(signedAmountFor("income", toCents(500_000))).toBe(500_000);
    expect(signedAmountFor("refund", toCents(1))).toBe(1);
  });

  it("keeps a legal zero at exactly positive zero for every kind", () => {
    // Zero is legal for ordinary rows (transactions_sign_by_kind_ck is
    // non-strict), and `-0` must never be produced: it is `=== 0` but
    // stringifies as "-0" and survives into JSON as a negative zero amount.
    for (const kind of ORDINARY_TRANSACTION_KINDS) {
      const zero = signedAmountFor(kind, toCents(0));
      expect(zero).toBe(0);
      expect(Object.is(zero, -0)).toBe(false);
      expect(JSON.stringify(zero)).toBe("0");
    }
  });

  it("agrees with the database's sign check for every ordinary kind", () => {
    // The mirror claim, stated as the constraint states it.
    for (const magnitude of [0, 1, 999, 1_234_567]) {
      expect(signedAmountFor("income", toCents(magnitude))).toBeGreaterThanOrEqual(0);
      expect(signedAmountFor("refund", toCents(magnitude))).toBeGreaterThanOrEqual(0);
      expect(signedAmountFor("expense", toCents(magnitude))).toBeLessThanOrEqual(0);
    }
  });

  it("throws on a negative magnitude rather than taking its absolute value", () => {
    // Validation has already rejected a negative amount with an actionable
    // message. Flipping one silently here would let a value that bypassed
    // validation produce a plausible-looking row.
    expect(() => signedAmountFor("expense", toCents(-100))).toThrow();
    expect(() => signedAmountFor("income", toCents(-1))).toThrow();
  });
});
