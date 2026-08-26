import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { translateCategory } from "./support/id-translation";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getCategories } = await import("@/lib/data/categories");
const oracle = await import("@/lib/mock/dal");

beforeAll(async () => {
  const context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

describe("getCategories parity", () => {
  it("matches the fixture oracle row-for-row after id translation, all categories retained", async () => {
    const expected = (await oracle.getCategories())
      .map(translateCategory)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const actual = await getCategories();

    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(expected.length);
  });
});
