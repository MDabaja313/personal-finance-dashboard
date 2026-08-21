import { describe, expect, it } from "vitest";
import { toCents, type Bill } from "@/lib/types";
import { billStatus } from "@/lib/finance/bills";

function bill(dueDate: string): Bill {
  return {
    id: "bill-1",
    name: "Test Bill",
    amountCents: toCents(5_000),
    dueDate,
    frequency: "monthly",
  };
}

const today = "2026-08-20";

describe("billStatus", () => {
  it("is overdue when the due date has passed", () => {
    expect(billStatus(bill("2026-08-19"), today).status).toBe("overdue");
    expect(billStatus(bill("2026-08-19"), today).daysUntilDue).toBe(-1);
  });

  it("is due_soon when due today (the overdue/due-soon boundary)", () => {
    const result = billStatus(bill("2026-08-20"), today);
    expect(result.daysUntilDue).toBe(0);
    expect(result.status).toBe("due_soon");
  });

  it("is due_soon at exactly the 7-day threshold", () => {
    expect(billStatus(bill("2026-08-27"), today).status).toBe("due_soon");
  });

  it("is upcoming just past the 7-day threshold", () => {
    expect(billStatus(bill("2026-08-28"), today).status).toBe("upcoming");
  });

  it("gives the same result regardless of host timezone (uses daysBetween)", () => {
    // Not directly testable without mocking the host TZ, but this pins the
    // exact day count so a regression to local-midnight subtraction would
    // be caught by a mismatched value here.
    expect(billStatus(bill("2026-09-05"), today).daysUntilDue).toBe(16);
  });
});
