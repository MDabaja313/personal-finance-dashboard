import type { CalendarDate, Cents, TransactionKind } from "@/lib/types";

/** Display-ready row — account/category ids already resolved to names. */
export interface TransactionRow {
  id: string;
  date: CalendarDate;
  merchant: string;
  categoryName: string | null;
  accountName: string;
  kind: TransactionKind;
  amountCents: Cents;
}
