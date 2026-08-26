import { describe, expect, it } from "vitest";

import { getAccounts } from "@/lib/data/accounts";
import { getBills, getUpcomingBills } from "@/lib/data/bills";
import { getBudgets } from "@/lib/data/budgets";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getGoals } from "@/lib/data/goals";
import { getNetWorthHistory } from "@/lib/data/net-worth";
import { getRecentTransactions, getTransactions } from "@/lib/data/transactions";
import * as oracle from "@/lib/mock/dal";

/**
 * Checkpoint 1 only.
 *
 * `ordering.test.ts` and `transactions.test.ts` now assert the fixture oracle
 * rather than `lib/data/**` — that repointing is what keeps their fixture-slug
 * assertions running offline once the DAL goes to Supabase. This file covers
 * the gap that opens in the meantime: that the production functions still
 * return exactly what the oracle returns, so "the application is still
 * fixture-backed and unchanged" is asserted rather than asserted-by-eyeball.
 *
 * It is deliberately temporary. Checkpoint 2 onward, `lib/data/**` queries the
 * database and equivalence to the oracle becomes `npm run test:parity`'s job,
 * against seeded UUIDs rather than fixture slugs. Each function is deleted
 * from this file as its Supabase implementation lands, and the file goes with
 * the last one.
 */
describe("Checkpoint 1 — lib/data/** still delegates to the fixture oracle", () => {
  it("getAccounts", async () => {
    expect(await getAccounts()).toEqual(await oracle.getAccounts());
  });

  it("getCategories", async () => {
    expect(await getCategories()).toEqual(await oracle.getCategories());
  });

  it("getTransactions — unfiltered", async () => {
    expect(await getTransactions()).toEqual(await oracle.getTransactions());
  });

  it("getTransactions — across the filter surface", async () => {
    const cases: Parameters<typeof getTransactions>[0][] = [
      { month: "2026-08" },
      { from: "2026-08-16", to: "2026-08-19" },
      { month: "2026-08", from: "2026-08-16" },
      { month: "2026-08", to: "2026-01-01" },
      { kind: "expense", accountId: "acc-credit" },
      { categoryId: "cat-groceries" },
      { search: "whole" },
    ];

    for (const filters of cases) {
      expect(await getTransactions(filters)).toEqual(await oracle.getTransactions(filters));
    }
  });

  it("getRecentTransactions", async () => {
    expect(await getRecentTransactions(5)).toEqual(await oracle.getRecentTransactions(5));
  });

  it("getBudgets", async () => {
    expect(await getBudgets("2026-08")).toEqual(await oracle.getBudgets("2026-08"));
    expect(await getBudgets("2019-01")).toEqual([]);
  });

  it("getBills", async () => {
    expect(await getBills()).toEqual(await oracle.getBills());
  });

  it("getUpcomingBills", async () => {
    expect(await getUpcomingBills(3)).toEqual(await oracle.getUpcomingBills(3));
  });

  it("getGoals", async () => {
    expect(await getGoals()).toEqual(await oracle.getGoals());
  });

  it("getNetWorthHistory — including the months === 0 contract", async () => {
    for (const months of [undefined, 0, 1, 3, 99]) {
      expect(await getNetWorthHistory(months)).toEqual(await oracle.getNetWorthHistory(months));
    }

    // Guarded explicitly, not just by equality with the oracle: `slice(-0)` is
    // `slice(0)`, so zero means "all history", not "none". The Supabase
    // implementation preserves this by applying a LIMIT only for a positive
    // `months`.
    expect(await getNetWorthHistory(0)).toEqual(await getNetWorthHistory());
    expect((await getNetWorthHistory(0)).length).toBe(6);
  });

  it("getToday", async () => {
    expect(await getToday()).toBe(await oracle.getToday());
    expect(await getToday()).toBe("2026-08-20");
  });
});
