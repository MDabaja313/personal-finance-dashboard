import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { translateTransaction } from "./support/id-translation";
import { uuidFor } from "@/scripts/seed-identity";
import type { Transaction } from "@/lib/types";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getRecentTransactions, getTransactions } = await import("@/lib/data/transactions");
type TransactionFilters = Parameters<typeof getTransactions>[0];
const oracle = await import("@/lib/mock/dal");

let context: Awaited<ReturnType<typeof createParityContext>>;

beforeAll(async () => {
  context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

/**
 * The oracle speaks fixture slugs; the database speaks the deterministic
 * UUIDs the seed persisted them under. Filters that carry an id have to be
 * translated on the way *in*, results on the way *out*.
 */
function translateFilters(filters: TransactionFilters = {}): TransactionFilters {
  return {
    ...filters,
    ...(filters.accountId === undefined ? {} : { accountId: uuidFor(filters.accountId) }),
    ...(filters.categoryId === undefined ? {} : { categoryId: uuidFor(filters.categoryId) }),
  };
}

async function expected(filters: TransactionFilters = {}): Promise<Transaction[]> {
  return (await oracle.getTransactions(filters)).map(translateTransaction);
}

/** Row-for-row parity, in order, for one filter set. */
async function expectParity(filters: TransactionFilters = {}): Promise<Transaction[]> {
  const rows = await getTransactions(translateFilters(filters));
  expect(rows).toEqual(await expected(filters));
  return rows;
}

describe("getTransactions parity — no filters", () => {
  it("returns every seeded transaction, row for row, in date DESC / created_at DESC / id ASC order", async () => {
    const rows = await expectParity();
    expect(rows).toHaveLength(104);
  });

  it("never exposes created_at on the DTO, even though it is the ordering key", async () => {
    const rows = await getTransactions();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        expect.arrayContaining(["id", "accountId", "date", "merchant", "kind", "amountCents"])
      );
      expect(row).not.toHaveProperty("created_at");
      expect(row).not.toHaveProperty("createdAt");
      expect(row).not.toHaveProperty("user_id");
    }
  });
});

describe("getTransactions parity — date bounds", () => {
  it("`from` is inclusive", async () => {
    const rows = await expectParity({ from: "2026-08-19" });
    expect(rows.map((r) => r.id)).toEqual([uuidFor("txn-104")]);
  });

  it("`to` is inclusive", async () => {
    const rows = await expectParity({ to: "2026-03-01" });
    expect(rows.map((r) => r.id)).toEqual([uuidFor("txn-002"), uuidFor("txn-001")]);
  });

  it("both bounds together", async () => {
    const rows = await expectParity({ from: "2026-08-13", to: "2026-08-14" });
    expect(rows.map((r) => r.id)).toEqual([uuidFor("txn-096"), uuidFor("txn-095")]);
  });

  it("`month` is sugar for the equivalent monthStart/monthEnd range", async () => {
    const viaMonth = await expectParity({ month: "2026-08" });
    const viaRange = await getTransactions({ from: "2026-08-01", to: "2026-08-31" });
    expect(viaMonth).toEqual(viaRange);
    expect(viaMonth.length).toBeGreaterThan(0);
  });

  it("`month` intersected with an explicit `from` — the later lower bound wins", async () => {
    const rows = await expectParity({ month: "2026-08", from: "2026-08-16" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.date >= "2026-08-16" && r.date <= "2026-08-31")).toBe(true);
  });

  it("`month` intersected with an explicit `to` — the earlier upper bound wins", async () => {
    const rows = await expectParity({ month: "2026-08", to: "2026-08-14" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.date >= "2026-08-01" && r.date <= "2026-08-14")).toBe(true);
  });

  it("a non-overlapping intersection returns [] without throwing", async () => {
    await expect(getTransactions({ month: "2026-08", to: "2026-01-01" })).resolves.toEqual([]);
    expect(await expected({ month: "2026-08", to: "2026-01-01" })).toEqual([]);
  });
});

describe("getTransactions parity — column filters", () => {
  it("accountId", async () => {
    const rows = await expectParity({ accountId: "acc-credit" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.accountId === uuidFor("acc-credit"))).toBe(true);
  });

  it("categoryId", async () => {
    const rows = await expectParity({ categoryId: "cat-groceries" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.categoryId === uuidFor("cat-groceries"))).toBe(true);
  });

  it("kind — every member of the union, including both movement kinds", async () => {
    for (const kind of ["income", "expense", "refund", "transfer", "credit_card_payment"] as const) {
      const rows = await expectParity({ kind });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.kind === kind)).toBe(true);
    }
  });

  it("composes date bounds with kind and accountId", async () => {
    const rows = await expectParity({
      from: "2026-08-01",
      to: "2026-08-19",
      kind: "expense",
      accountId: "acc-credit",
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("composes a category filter with a month", async () => {
    const rows = await expectParity({ month: "2026-08", categoryId: "cat-dining" });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("getTransactions parity — movement legs", () => {
  it("both legs of each movement stay visible, carrying movement_id straight off the transactions row", async () => {
    const rows = await getTransactions({ kind: "transfer", month: "2026-08" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([uuidFor("txn-098"), uuidFor("txn-099")].sort());
    expect(rows.every((r) => r.movementId === uuidFor("mov-transfer-2026-08"))).toBe(true);
    // The legs sum to zero and never carry a category.
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(0);
    expect(rows.every((r) => r.categoryId === undefined)).toBe(true);
  });

  it("credit-card-payment legs likewise", async () => {
    const rows = await getTransactions({ kind: "credit_card_payment", month: "2026-08" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.movementId === uuidFor("mov-ccpay-2026-08"))).toBe(true);
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(0);
  });
});

describe("getTransactions parity — same-day ordering by created_at DESC", () => {
  it("orders the 2026-08-18 group by entry recency, not by id", async () => {
    const rows = await expectParity({ from: "2026-08-18", to: "2026-08-18" });
    expect(rows.map((r) => r.id)).toEqual([
      uuidFor("txn-103"),
      uuidFor("txn-102"),
      uuidFor("txn-101"),
    ]);
  });

  it("orders the 2026-08-16 group the same way", async () => {
    const rows = await expectParity({ from: "2026-08-16", to: "2026-08-16" });
    expect(rows.map((r) => r.id)).toEqual([
      uuidFor("txn-100"),
      uuidFor("txn-099"),
      uuidFor("txn-098"),
    ]);
  });

  it("orders distinct dates newest first, with the same-day groups nested inside", async () => {
    const rows = await expectParity({ from: "2026-08-16", to: "2026-08-19" });
    expect(rows.map((r) => r.id)).toEqual(
      [
        "txn-104",
        "txn-103",
        "txn-102",
        "txn-101",
        "txn-100",
        "txn-099",
        "txn-098",
      ].map(uuidFor)
    );
  });

  it("the id tie-break is unreachable on this data — created_at is unique per row", async () => {
    // Stated explicitly because it is why translating ids before comparison
    // cannot change the expected order here: the UUID ordering never decides
    // anything. (It is still the documented third key, and the seeded
    // bill_occurrences reduction exercises an id tie-break of its own.)
    const rows = await getTransactions();
    const byDate = new Map<string, number>();
    for (const row of rows) byDate.set(row.date, (byDate.get(row.date) ?? 0) + 1);
    expect([...byDate.values()].some((count) => count > 1)).toBe(true);
  });
});

/**
 * ## What the search tests actually prove
 *
 * The fixture contract is `merchant.toLowerCase().includes(query)` — plain
 * substring, no wildcards. Reproducing that over `ilike` means every SQL
 * `LIKE` metacharacter in the user's text has to be escaped, and PostgREST
 * adds one of its own: `*` is an alias for `%` in `like`/`ilike` values.
 *
 * **Proved here, against the real seeded database:**
 *
 *  - The raw (unescaped) pattern *is* a wildcard match — it returns rows.
 *    Without this half, "the escaped pattern returned nothing" would be
 *    vacuous.
 *  - The escaped pattern the DAL actually sends returns nothing, and nothing
 *    is the correct answer, because the oracle's `String.includes()` also
 *    returns nothing for that literal text.
 *  - Escaping does not over-escape: ordinary searches still match, case
 *    insensitively, exactly as the oracle does.
 *
 * **Not proved here, and deliberately not faked:** that an escaped `%`/`_`
 * still *matches* a merchant containing a literal `%`/`_`. No seeded merchant
 * contains one, and this suite does not mutate production tables or add write
 * grants to manufacture one. That half is pinned instead by
 * `lib/data/filters.test.ts`, which asserts the exact pattern string sent, on
 * top of Postgres's standard `LIKE` escape semantics.
 */
describe("getTransactions parity — search", () => {
  /** The same query the DAL issues, minus the escaping — the control case. */
  async function rawIlike(pattern: string): Promise<number> {
    const { data, error } = await context.client
      .from("transactions")
      .select("id")
      .eq("user_id", context.ownerId)
      .ilike("merchant", pattern);
    expect(error).toBeNull();
    return data!.length;
  }

  it("matches case-insensitively, like the oracle's toLowerCase().includes()", async () => {
    for (const search of ["whole", "WHOLE FOODS", "WhOlE fOoDs MaRkEt", "netflix", "joe's"]) {
      const rows = await expectParity({ search });
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("still composes with the other filters", async () => {
    const rows = await expectParity({ search: "trader", month: "2026-08", accountId: "acc-checking" });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("an empty search string applies no filter at all", async () => {
    expect(await expectParity({ search: "" })).toHaveLength(104);
  });

  it("'_' stays literal — it does not act as a single-character wildcard", async () => {
    // Control: unescaped, '_' matches the 'h' in "Shell Gas Station".
    expect(await rawIlike("%S_ell%")).toBeGreaterThan(0);
    // And no merchant contains the literal text "S_ell", so [] is correct.
    expect(await oracle.getTransactions({ search: "S_ell" })).toEqual([]);
    expect(await expectParity({ search: "S_ell" })).toEqual([]);
  });

  it("'%' stays literal — it does not act as a multi-character wildcard", async () => {
    expect(await rawIlike("%T%t%")).toBeGreaterThan(0);
    expect(await oracle.getTransactions({ search: "T%t" })).toEqual([]);
    expect(await expectParity({ search: "T%t" })).toEqual([]);
  });

  it("'*' stays literal — PostgREST aliases it to '%' in ilike values", async () => {
    // Control, twice over: '*' alone matches every row, and '%S*ell%'
    // matches "Shell Gas Station" exactly the way '%S_ell%' does.
    expect(await rawIlike("*")).toBe(104);
    expect(await rawIlike("%S*ell%")).toBeGreaterThan(0);
    expect(await oracle.getTransactions({ search: "S*ell" })).toEqual([]);
    expect(await expectParity({ search: "S*ell" })).toEqual([]);
  });

  it("a backslash is escaped rather than consuming the next character", async () => {
    // A lone trailing backslash is what a naive escaper leaves dangling; the
    // query must run and return the oracle's answer, not error.
    for (const search of ["\\", "a\\", "\\%", "\\_", "%\\"]) {
      expect(await oracle.getTransactions({ search })).toEqual([]);
      expect(await expectParity({ search })).toEqual([]);
    }
  });

  it("characters with PostgREST query-string meaning pass through safely", async () => {
    for (const search of ["a,b", "(a)", 'a"b', "a.b", "a:b", "&", "Electric & Water"]) {
      await expectParity({ search });
    }
  });
});

describe("getRecentTransactions parity", () => {
  it("matches the oracle at representative limits", async () => {
    for (const limit of [0, 1, 3, 5, 10, 104, 200]) {
      const rows = await getRecentTransactions(limit);
      expect(rows).toEqual((await oracle.getRecentTransactions(limit)).map(translateTransaction));
      expect(rows.length).toBe(Math.min(limit, 104));
    }
  });

  it("uses the same ordering as getTransactions — a prefix of the full list", async () => {
    const all = await getTransactions();
    expect(await getRecentTransactions(5)).toEqual(all.slice(0, 5));
    expect((await getRecentTransactions(5)).map((r) => r.id)).toEqual(
      ["txn-104", "txn-103", "txn-102", "txn-101", "txn-100"].map(uuidFor)
    );
  });

  it("rejects an invalid limit instead of coercing it", async () => {
    for (const limit of [-1, 2.5, NaN]) {
      await expect(getRecentTransactions(limit)).rejects.toMatchObject({ code: "data_integrity" });
    }
  });
});

describe("movements stays inaccessible to authenticated", () => {
  it("SELECT on public.movements fails at the privilege layer (42501)", async () => {
    const { data, error } = await context.client.from("movements").select("id").limit(1);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("...yet every movement leg still carries its movementId", async () => {
    const legs = await getTransactions({ kind: "transfer" });
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((leg) => typeof leg.movementId === "string" && leg.movementId.length > 0)).toBe(true);
  });
});
