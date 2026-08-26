/**
 * The legacy DAL's filtering/ordering contract for transactions, asserted
 * against the fixture oracle (`lib/mock/dal.ts`) rather than
 * `lib/data/transactions.ts`.
 *
 * Phase 6 Checkpoint 1 repointed these imports; every assertion is unchanged.
 * See lib/data/ordering.test.ts for the full rationale.
 */
import { describe, expect, it } from "vitest";
import { getRecentTransactions, getTransactions } from "@/lib/mock/dal";
import { monthEnd, monthStart } from "@/lib/finance/dates";

async function ids(...args: Parameters<typeof getTransactions>) {
  return (await getTransactions(...args)).map((t) => t.id);
}

describe("getTransactions — from/to bounds", () => {
  it("includes a transaction exactly on the `from` boundary (inclusive)", async () => {
    const result = await ids({ from: "2026-08-19", to: "2026-08-19" });
    expect(result).toEqual(["txn-104"]);
  });

  it("includes a transaction exactly on the `to` boundary (inclusive)", async () => {
    const result = await ids({ from: "2026-08-13", to: "2026-08-14" });
    expect(result).toEqual(["txn-096", "txn-095"]);
  });

  it("excludes dates outside the range on either side", async () => {
    const result = await ids({ from: "2026-08-14", to: "2026-08-15" });
    expect(result).not.toContain("txn-095"); // 2026-08-13, before `from`
    expect(result).not.toContain("txn-098"); // 2026-08-16, after `to`
  });

  it("supports an open-ended `from` (no upper bound)", async () => {
    const result = await ids({ from: "2026-08-19" });
    expect(result).toEqual(["txn-104"]);
  });

  it("supports an open-ended `to` (no lower bound)", async () => {
    const result = await getTransactions({ to: "2026-03-01" });
    expect(result.every((t) => t.date <= "2026-03-01")).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getTransactions — month equivalence", () => {
  it("`month` is equivalent to the corresponding monthStart/monthEnd range", async () => {
    const viaMonth = await ids({ month: "2026-08" });
    const viaRange = await ids({ from: monthStart("2026-08"), to: monthEnd("2026-08") });
    expect(viaMonth).toEqual(viaRange);
    expect(viaMonth.length).toBeGreaterThan(0);
  });
});

describe("getTransactions — month + from/to intersect", () => {
  it("narrows to the tighter of the two lower bounds", async () => {
    const result = await getTransactions({ month: "2026-08", from: "2026-08-16" });
    expect(result.every((t) => t.date >= "2026-08-16")).toBe(true);
    expect(result.some((t) => t.date === "2026-08-16")).toBe(true);
  });

  it("narrows to the tighter of the two upper bounds", async () => {
    const result = await getTransactions({ month: "2026-08", to: "2026-08-14" });
    expect(result.every((t) => t.date <= "2026-08-14")).toBe(true);
  });

  it("returns [] for a non-overlapping intersection, without throwing", async () => {
    await expect(getTransactions({ month: "2026-08", to: "2026-01-01" })).resolves.toEqual([]);
  });
});

describe("getTransactions — filter composition", () => {
  it("combines a date range with kind and accountId", async () => {
    const result = await getTransactions({
      from: "2026-08-01",
      to: "2026-08-19",
      kind: "expense",
      accountId: "acc-credit",
    });
    expect(result.length).toBeGreaterThan(0);
    for (const t of result) {
      expect(t.kind).toBe("expense");
      expect(t.accountId).toBe("acc-credit");
      expect(t.date >= "2026-08-01" && t.date <= "2026-08-19").toBe(true);
    }
  });
});

describe("getTransactions — ordering: date DESC, created_at DESC, id ASC", () => {
  it("orders same-day rows by fixture-entry recency (later entry first), not by id", async () => {
    // Three transactions all dated 2026-08-18: txn-101, txn-102, txn-103 in
    // fixture order. The mock's created_at stand-in is fixture-array index,
    // so the most recently *entered* (highest index) sorts first: 103, 102, 101.
    const result = await ids({ from: "2026-08-18", to: "2026-08-18" });
    expect(result).toEqual(["txn-103", "txn-102", "txn-101"]);
  });

  it("orders a second same-day group the same way", async () => {
    // 2026-08-16: txn-098, txn-099, txn-100 in fixture order -> reversed.
    const result = await ids({ from: "2026-08-16", to: "2026-08-16" });
    expect(result).toEqual(["txn-100", "txn-099", "txn-098"]);
  });

  it("orders distinct dates newest first", async () => {
    const result = await ids({ from: "2026-08-16", to: "2026-08-19" });
    expect(result).toEqual([
      "txn-104", // 2026-08-19
      "txn-103", "txn-102", "txn-101", // 2026-08-18
      "txn-100", "txn-099", "txn-098", // 2026-08-16
    ]);
  });
});

describe("getRecentTransactions", () => {
  it("returns a deterministic set for the same limit — regression lock", async () => {
    const result = (await getRecentTransactions(5)).map((t) => t.id);
    expect(result).toEqual(["txn-104", "txn-103", "txn-102", "txn-101", "txn-100"]);
  });
});
