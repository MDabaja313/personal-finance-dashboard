import { daysBetween } from "@/lib/finance/dates";
import type { Bill, CalendarDate } from "@/lib/types";

export type BillStatusKind = "overdue" | "due_soon" | "upcoming";

export interface BillStatus {
  bill: Bill;
  /** Negative when overdue, 0 when due today. */
  daysUntilDue: number;
  status: BillStatusKind;
}

const DUE_SOON_THRESHOLD_DAYS = 7;

/** `today` is always explicit — this module never reads the clock. */
export function billStatus(bill: Bill, today: CalendarDate): BillStatus {
  const daysUntilDue = daysBetween(today, bill.dueDate);

  let status: BillStatusKind;
  if (daysUntilDue < 0) {
    status = "overdue";
  } else if (daysUntilDue <= DUE_SOON_THRESHOLD_DAYS) {
    status = "due_soon";
  } else {
    status = "upcoming";
  }

  return { bill, daysUntilDue, status };
}
