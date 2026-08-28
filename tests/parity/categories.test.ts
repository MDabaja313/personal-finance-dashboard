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

  it("exposes archive state from the database, without filtering on it", async () => {
    // Phase 7 CP2 added `isArchived` to the Category DTO. Two properties, and
    // the second is the one that could regress silently: the flag must come
    // from the row (not be defaulted in the mapper), and exposing it must not
    // turn into filtering by it — an archived category is what resolves the
    // label on a historical transaction, so the count must stay the oracle's.
    const actual = await getCategories();

    for (const category of actual) {
      expect(typeof category.isArchived, `${category.name} carries a boolean archive flag`).toBe(
        "boolean"
      );
    }

    expect(actual).toHaveLength((await oracle.getCategories()).length);
  });
});
