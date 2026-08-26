import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getAccounts } = await import("@/lib/data/accounts");
const { getNetWorthHistory } = await import("@/lib/data/net-worth");
const { totalAssets, totalLiabilities, netWorth } = await import("@/lib/finance/accounts");

beforeAll(async () => {
  const context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

describe("cross-table invariant: latest net worth snapshot vs. live account aggregate", () => {
  it("equals the aggregate assets/liabilities/net worth computed from getAccounts()", async () => {
    const accounts = await getAccounts();
    const history = await getNetWorthHistory();
    const latest = history.at(-1);

    expect(latest).toBeDefined();
    expect(latest!.assetsCents).toBe(totalAssets(accounts));
    expect(latest!.liabilitiesCents).toBe(totalLiabilities(accounts));
    expect(latest!.netWorthCents).toBe(netWorth(accounts));
  });
});
