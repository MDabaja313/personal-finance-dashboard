import { describe, expect, it } from "vitest";
import { getAccounts } from "@/lib/data/accounts";
import { getBills, getUpcomingBills } from "@/lib/data/bills";
import { getBudgets } from "@/lib/data/budgets";
import { getCategories } from "@/lib/data/categories";
import { getGoals } from "@/lib/data/goals";
import { getNetWorthHistory } from "@/lib/data/net-worth";

describe("getAccounts ordering — name ASC, id ASC", () => {
  it("returns accounts alphabetically by name, independent of fixture order", async () => {
    const ids = (await getAccounts()).map((a) => a.id);
    expect(ids).toEqual([
      "acc-loan", // "Auto Loan"
      "acc-investment", // "Brokerage Account"
      "acc-cash", // "Cash Wallet"
      "acc-checking", // "Everyday Checking"
      "acc-savings", // "High-Yield Savings"
      "acc-old-checking", // "Old Checking (Closed)"
      "acc-credit", // "Rewards Credit Card"
    ]);
  });
});

describe("getCategories ordering — name ASC, id ASC", () => {
  it("returns categories alphabetically by name, independent of fixture order", async () => {
    const ids = (await getCategories()).map((c) => c.id);
    expect(ids).toEqual([
      "cat-dining",
      "cat-entertainment",
      "cat-groceries",
      "cat-healthcare",
      "cat-housing",
      "cat-insurance",
      "cat-interest",
      "cat-salary",
      "cat-shopping",
      "cat-subscriptions",
      "cat-transportation",
      "cat-utilities",
    ]);
  });
});

describe("getBills / getUpcomingBills ordering — due_date ASC, name ASC, id ASC", () => {
  it("getBills sorts by due date ascending, overdue first", async () => {
    const ids = (await getBills()).map((b) => b.id);
    expect(ids).toEqual(["bill-electric", "bill-streaming", "bill-internet", "bill-gym", "bill-insurance"]);
  });

  it("getUpcomingBills applies the same order before limiting", async () => {
    const ids = (await getUpcomingBills(3)).map((b) => b.id);
    expect(ids).toEqual(["bill-electric", "bill-streaming", "bill-internet"]);
  });
});

describe("getGoals ordering — target_date ASC NULLS LAST, name ASC, id ASC", () => {
  it("sorts by soonest target date, undated goals last", async () => {
    const ids = (await getGoals()).map((g) => g.id);
    expect(ids).toEqual([
      "goal-europe-trip", // 2026-10-01
      "goal-emergency-fund", // 2026-12-31
      "goal-car-down-payment", // 2027-06-01
      "goal-home-renovation", // no target date -> last
    ]);
  });
});

describe("getNetWorthHistory ordering — month ASC", () => {
  it("returns the full history chronologically", async () => {
    const months = (await getNetWorthHistory()).map((s) => s.month);
    expect(months).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
  });

  it("returns the most recent N snapshots, still in chronological order", async () => {
    const months = (await getNetWorthHistory(3)).map((s) => s.month);
    expect(months).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});

describe("getBudgets ordering — category_id ASC, id ASC (technical only, not a display order)", () => {
  it("returns a deterministic technical order independent of fixture order", async () => {
    const ids = (await getBudgets("2026-08")).map((b) => b.id);
    expect(ids).toEqual([
      "bud-2026-08-dining",
      "bud-2026-08-entertainment",
      "bud-2026-08-groceries",
      "bud-2026-08-housing",
      "bud-2026-08-shopping",
      "bud-2026-08-subscriptions",
      "bud-2026-08-transportation",
      "bud-2026-08-utilities",
    ]);
  });
});
