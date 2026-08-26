import { beforeAll, describe, expect, it, vi } from "vitest";

import { createParityContext } from "./support/context";
import { translateBill } from "./support/id-translation";
import { uuidFor } from "@/scripts/seed-identity";

const mocks = vi.hoisted(() => ({ client: undefined as unknown, ownerId: undefined as unknown as string }));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

const { getBills, getUpcomingBills } = await import("@/lib/data/bills");
const oracle = await import("@/lib/mock/dal");

let context: Awaited<ReturnType<typeof createParityContext>>;

beforeAll(async () => {
  context = await createParityContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

/**
 * The oracle's `Bill.dueDate` is a literal fixture field. The DAL's is
 * projected from real `bill_occurrences` rows, and the seed deliberately
 * back-dates each bill's `anchor_date` so that projection lands on the same
 * date. That is the thing under test: parity here is only meaningful because
 * the two values are computed from completely different places.
 */
describe("getBills parity", () => {
  it("returns all five active bills, row for row, in due_date ASC / name ASC / id ASC order", async () => {
    const actual = await getBills();
    expect(actual).toEqual((await oracle.getBills()).map(translateBill));
    expect(actual).toHaveLength(5);
  });

  it("projects the exact due dates, from bill_occurrences rather than the fixture field", async () => {
    const actual = await getBills();
    expect(actual.map((bill) => [bill.id, bill.dueDate])).toEqual([
      [uuidFor("bill-electric"), "2026-08-18"], // overdue vs. MOCK_TODAY 2026-08-20
      [uuidFor("bill-streaming"), "2026-08-22"],
      [uuidFor("bill-internet"), "2026-08-23"],
      [uuidFor("bill-gym"), "2026-09-01"],
      [uuidFor("bill-insurance"), "2026-09-05"],
    ]);
  });

  it("carries the mapped cents and optional ids", async () => {
    const bills = await getBills();
    const electric = bills.find((bill) => bill.id === uuidFor("bill-electric"))!;

    expect(electric.amountCents).toBe(14500);
    expect(electric.frequency).toBe("monthly");
    expect(electric.categoryId).toBe(uuidFor("cat-utilities"));
    expect(electric.accountId).toBe(uuidFor("acc-checking"));
  });

  it("uses the earliest SCHEDULED occurrence — paid and skipped history never displaces it", async () => {
    // The seed gives every bill a run of historical occurrences. Read them
    // back directly: for each bill, the DAL's dueDate must equal the minimum
    // `scheduled` due_date, and must NOT equal the minimum due_date overall
    // (which is always an older paid one).
    const { data, error } = await context.client
      .from("bill_occurrences")
      .select("bill_id, due_date, status")
      .eq("user_id", context.ownerId)
      .order("due_date", { ascending: true });

    expect(error).toBeNull();
    const occurrences = data as { bill_id: string; due_date: string; status: string }[];
    expect(occurrences.length).toBeGreaterThan(5);

    for (const bill of await getBills()) {
      const mine = occurrences.filter((occurrence) => occurrence.bill_id === bill.id);
      const scheduled = mine.filter((occurrence) => occurrence.status === "scheduled");
      const nonScheduled = mine.filter((occurrence) => occurrence.status !== "scheduled");

      expect(scheduled.length).toBeGreaterThan(0);
      expect(nonScheduled.length).toBeGreaterThan(0);
      expect(bill.dueDate).toBe(scheduled[0].due_date);
      // Every paid/skipped occurrence is older than the projected due date,
      // so "earliest overall" would have given a different, wrong answer.
      expect(mine[0].due_date).not.toBe(bill.dueDate);
      expect(nonScheduled.every((occurrence) => occurrence.due_date < bill.dueDate)).toBe(true);
    }
  });

  it("gym's skipped 2026-08-01 occurrence is passed over for its 2026-09-01 scheduled one", async () => {
    // The one bill in the seed whose most recent non-scheduled occurrence is
    // `skipped` rather than `paid` — a status filter that only excluded
    // 'paid' would return 2026-08-01 here.
    const gym = (await getBills()).find((bill) => bill.id === uuidFor("bill-gym"))!;
    expect(gym.dueDate).toBe("2026-09-01");
  });
});

describe("getUpcomingBills parity", () => {
  it("matches the oracle at representative limits", async () => {
    for (const limit of [0, 1, 3, 5, 10]) {
      const actual = await getUpcomingBills(limit);
      expect(actual).toEqual((await oracle.getUpcomingBills(limit)).map(translateBill));
      expect(actual.length).toBe(Math.min(limit, 5));
    }
  });

  it("is a prefix of getBills() — soonest due date first", async () => {
    const bills = await getBills();
    expect(await getUpcomingBills(3)).toEqual(bills.slice(0, 3));
  });

  it("applies no `today` filter — the overdue bill still sorts first", async () => {
    const today = await oracle.getToday();
    const upcoming = await getUpcomingBills(3);

    expect(upcoming[0].id).toBe(uuidFor("bill-electric"));
    expect(upcoming[0].dueDate < today).toBe(true);
  });

  it("rejects an invalid limit instead of coercing it", async () => {
    for (const limit of [-1, 2.5, NaN]) {
      await expect(getUpcomingBills(limit)).rejects.toMatchObject({ code: "data_integrity" });
    }
  });
});
