import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { translateBudget } from "./support/id-translation";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getBudgets } = await import("@/lib/data/budgets");
const oracle = await import("@/lib/mock/dal");

beforeAll(async () => {
  const context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

describe("getBudgets parity", () => {
  it("matches the fixture oracle row-for-row for the seeded 2026-08 period, ids translated before ordering", async () => {
    // Translate first, THEN sort by category_id ASC, id ASC in the UUID
    // domain — the production ordering key is the persisted UUID, which has
    // no relationship to the fixture slug's own lexicographic order.
    const expected = (await oracle.getBudgets("2026-08"))
      .map(translateBudget)
      .sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.id.localeCompare(b.id));

    const actual = await getBudgets("2026-08");

    expect(actual).toEqual(expected);
  });

  it("returns nothing for a period with no seeded budgets", async () => {
    expect(await getBudgets("2019-01")).toEqual([]);
  });
});
