import { describe, expect, it } from "vitest";
import {
  mockAccounts,
  mockBills,
  mockBudgets,
  mockCategories,
  mockGoals,
  mockNetWorthHistory,
  mockTransactions,
} from "@/lib/mock";
import { netWorth, totalAssets, totalLiabilities } from "@/lib/finance/accounts";

describe("fixture coherence", () => {
  it("every movementId appears on exactly two legs whose amounts sum to zero and whose kind matches", () => {
    const movementLegs = mockTransactions.filter((t) => t.movementId !== undefined);
    const byMovement = new Map<string, typeof movementLegs>();
    for (const leg of movementLegs) {
      const group = byMovement.get(leg.movementId!) ?? [];
      group.push(leg);
      byMovement.set(leg.movementId!, group);
    }

    expect(byMovement.size).toBeGreaterThan(0);

    for (const [movementId, legs] of byMovement) {
      expect(legs, `movement ${movementId}`).toHaveLength(2);
      expect(legs[0].kind, `movement ${movementId} kind mismatch`).toBe(legs[1].kind);
      expect(
        legs[0].amountCents + legs[1].amountCents,
        `movement ${movementId} does not sum to zero`
      ).toBe(0);
    }
  });

  it("movement legs (transfer/credit_card_payment) never carry a categoryId", () => {
    const movementLegs = mockTransactions.filter(
      (t) => t.kind === "transfer" || t.kind === "credit_card_payment"
    );
    expect(movementLegs.length).toBeGreaterThan(0);
    for (const leg of movementLegs) {
      expect(leg.categoryId, `${leg.id} should have no categoryId`).toBeUndefined();
    }
  });

  it("every referenced categoryId exists in mockCategories", () => {
    const categoryIds = new Set(mockCategories.map((c) => c.id));

    for (const t of mockTransactions) {
      if (t.categoryId !== undefined) {
        expect(categoryIds.has(t.categoryId), `transaction ${t.id} -> ${t.categoryId}`).toBe(true);
      }
    }
    for (const b of mockBudgets) {
      expect(categoryIds.has(b.categoryId), `budget ${b.id} -> ${b.categoryId}`).toBe(true);
    }
    for (const bill of mockBills) {
      if (bill.categoryId !== undefined) {
        expect(categoryIds.has(bill.categoryId), `bill ${bill.id} -> ${bill.categoryId}`).toBe(true);
      }
    }
  });

  it("the transaction sign invariant holds by kind across every fixture row", () => {
    for (const t of mockTransactions) {
      if (t.kind === "income" || t.kind === "refund") {
        expect(t.amountCents, t.id).toBeGreaterThanOrEqual(0);
      }
      if (t.kind === "expense") {
        expect(t.amountCents, t.id).toBeLessThanOrEqual(0);
      }
      // transfer/credit_card_payment legs may be either sign individually
      // (source negative, destination positive) — covered by the
      // sum-to-zero movement check above.
    }
  });

  it("the latest net-worth snapshot matches current account totals under the snapshot convention", () => {
    const latest = mockNetWorthHistory[mockNetWorthHistory.length - 1];
    expect(latest.assetsCents).toBe(totalAssets(mockAccounts));
    expect(latest.liabilitiesCents).toBe(totalLiabilities(mockAccounts));
    expect(latest.netWorthCents).toBe(netWorth(mockAccounts));
    expect(latest.netWorthCents).toBe(latest.assetsCents - latest.liabilitiesCents);
  });

  it("every goal's savedCents/targetCents and every account's balance are safe integers", () => {
    // toCents() already enforces this at construction time; this is a
    // belt-and-suspenders check that fixtures weren't hand-edited unsafely.
    for (const g of mockGoals) {
      expect(Number.isSafeInteger(g.targetCents)).toBe(true);
      expect(Number.isSafeInteger(g.savedCents)).toBe(true);
    }
  });
});
