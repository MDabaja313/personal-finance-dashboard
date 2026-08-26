import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { translateAccount } from "./support/id-translation";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getAccounts } = await import("@/lib/data/accounts");
const oracle = await import("@/lib/mock/dal");

beforeAll(async () => {
  const context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

describe("getAccounts parity", () => {
  it("matches the fixture oracle row-for-row after id translation", async () => {
    const expected = (await oracle.getAccounts())
      .map(translateAccount)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const actual = await getAccounts();

    expect(actual).toEqual(expected);
  });

  it("includes the archived account", async () => {
    const actual = await getAccounts();

    expect(actual.some((a) => a.isArchived)).toBe(true);
  });

  it("derives balanceCents matching the fixture", async () => {
    const expectedById = new Map(
      (await oracle.getAccounts()).map((a) => [translateAccount(a).id, a.balanceCents])
    );

    for (const account of await getAccounts()) {
      expect(account.balanceCents).toBe(expectedById.get(account.id));
    }
  });
});
