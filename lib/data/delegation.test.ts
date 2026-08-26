import { describe, expect, it } from "vitest";

import { getToday } from "@/lib/data/clock";
import * as oracle from "@/lib/mock/dal";

/**
 * Checkpoint 1/2/3.
 *
 * `ordering.test.ts` and `transactions.test.ts` now assert the fixture oracle
 * rather than `lib/data/**` — that repointing is what keeps their fixture-slug
 * assertions running offline once the DAL goes to Supabase. This file covers
 * the gap that opens in the meantime: that the production functions still
 * return exactly what the oracle returns, so "the application is still
 * fixture-backed and unchanged" is asserted rather than asserted-by-eyeball.
 *
 * It is deliberately temporary, and now nearly empty. Checkpoint 2 migrated
 * `getAccounts`, `getCategories`, `getBudgets`, `getGoals`, and
 * `getNetWorthHistory`; Checkpoint 3 migrated `getTransactions`,
 * `getRecentTransactions`, `getBills`, and `getUpcomingBills`. Their
 * delegation assertions are removed here as each landed, and equivalence to
 * the oracle is now `npm run test:parity`'s job, against seeded UUIDs rather
 * than fixture slugs.
 *
 * `getToday()` is the last oracle-backed production function. Checkpoint 4
 * replaces it with the real clock (resolved through `profiles.timezone`), at
 * which point this file goes with it.
 */
describe("lib/data/** still delegates to the fixture oracle", () => {
  it("getToday", async () => {
    expect(await getToday()).toBe(await oracle.getToday());
    expect(await getToday()).toBe("2026-08-20");
  });
});
