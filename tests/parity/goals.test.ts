import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { translateGoal } from "./support/id-translation";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getGoals } = await import("@/lib/data/goals");
const oracle = await import("@/lib/mock/dal");

beforeAll(async () => {
  const context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

function sortGoals<T extends { targetDate?: string; name: string; id: string }>(goals: T[]): T[] {
  return [...goals].sort((a, b) => {
    if (a.targetDate === undefined && b.targetDate === undefined) {
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    }
    if (a.targetDate === undefined) return 1;
    if (b.targetDate === undefined) return -1;
    return a.targetDate.localeCompare(b.targetDate) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

describe("getGoals parity", () => {
  it("matches the fixture oracle row-for-row, savedCents derived from goal_balances", async () => {
    const expected = sortGoals((await oracle.getGoals()).map(translateGoal));

    const actual = await getGoals();

    expect(actual).toEqual(expected);
  });

  it("excludes archived goals exactly as the oracle does (none are seeded archived)", async () => {
    const expected = await oracle.getGoals();
    const actual = await getGoals();

    expect(actual).toHaveLength(expected.length);
  });
});
