import { describe, expect, it } from "vitest";

import { getBills, getUpcomingBills } from "@/lib/data/bills";
import { getToday } from "@/lib/data/clock";
import { getRecentTransactions, getTransactions } from "@/lib/data/transactions";
import * as oracle from "@/lib/mock/dal";

/**
 * Checkpoint 1/2.
 *
 * `ordering.test.ts` and `transactions.test.ts` now assert the fixture oracle
 * rather than `lib/data/**` — that repointing is what keeps their fixture-slug
 * assertions running offline once the DAL goes to Supabase. This file covers
 * the gap that opens in the meantime: that the production functions still
 * return exactly what the oracle returns, so "the application is still
 * fixture-backed and unchanged" is asserted rather than asserted-by-eyeball.
 *
 * It is deliberately temporary. Checkpoint 2 migrated `getAccounts`,
 * `getCategories`, `getBudgets`, `getGoals`, and `getNetWorthHistory` to
 * Supabase — their delegation assertions are removed here, and equivalence to
 * the oracle is now `npm run test:parity`'s job, against seeded UUIDs rather
 * than fixture slugs. Each remaining function is deleted from this file as
 * its Supabase implementation lands, and the file goes with the last one.
 */
describe("lib/data/** still delegates to the fixture oracle", () => {
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

  it("getBills", async () => {
    expect(await getBills()).toEqual(await oracle.getBills());
  });

  it("getUpcomingBills", async () => {
    expect(await getUpcomingBills(3)).toEqual(await oracle.getUpcomingBills(3));
  });

  it("getToday", async () => {
    expect(await getToday()).toBe(await oracle.getToday());
    expect(await getToday()).toBe("2026-08-20");
  });
});
