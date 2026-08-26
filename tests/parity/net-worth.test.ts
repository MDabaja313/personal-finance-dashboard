import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getNetWorthHistory } = await import("@/lib/data/net-worth");
const oracle = await import("@/lib/mock/dal");

beforeAll(async () => {
  const context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

describe("getNetWorthHistory parity", () => {
  it("undefined matches the oracle's full 6-row history", async () => {
    const expected = await oracle.getNetWorthHistory();
    const actual = await getNetWorthHistory();

    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(6);
  });

  it("0 also returns the full history — not an empty list", async () => {
    const expected = await oracle.getNetWorthHistory(0);
    const actual = await getNetWorthHistory(0);

    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(6);
  });

  it("a positive limit matches the oracle exactly, most recent N in chronological order", async () => {
    for (const months of [3, 6]) {
      expect(await getNetWorthHistory(months)).toEqual(await oracle.getNetWorthHistory(months));
    }
  });
});
