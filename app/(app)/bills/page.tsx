import { Receipt } from "lucide-react";

import { AddBill } from "@/components/bills/add-bill";
import { BillCard } from "@/components/bills/bill-card";
import type {
  BillOccurrenceRow,
  BillReferenceOption,
  TransactionOption,
} from "@/components/bills/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import {
  markBillOccurrencePaidAction,
  restoreBillOccurrenceAction,
  skipBillOccurrenceAction,
} from "@/lib/actions/bill-occurrences";
import { createBillAction, setBillArchivedAction, updateBillAction } from "@/lib/actions/bills";
import { getAccounts } from "@/lib/data/accounts";
import { getBillsForManagement, type BillManagement } from "@/lib/data/bills";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getRecentTransactions } from "@/lib/data/transactions";
import { billStatus, type BillStatusKind } from "@/lib/finance/bills";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { CalendarDate, Transaction } from "@/lib/types";

/**
 * Phase 7 CP7: `/bills` becomes the complete recurring-bill management
 * surface — add, edit, archive/unarchive, mark the next occurrence paid, skip
 * it, and correct any past occurrence from its history.
 *
 * The Server Actions are imported here, in `app/**`, and handed to the client
 * components as props: `components/**` may not value-import `lib/actions/**`,
 * and may not reach `lib/data/**` at all.
 *
 * ## No generation happens because this page rendered
 *
 * Every read below is a read. Occurrence generation is mutation-time
 * maintenance — `public.maintain_bill_schedule` is reachable only from the
 * bill RPCs and from `lib/data/mutations/bill-schedule.ts`, and neither is on
 * a render path. Opening `/bills` a hundred times writes nothing.
 *
 * ## `getBills()` is untouched
 *
 * The dashboard's upcoming-bill projection still reads it, still gets active
 * bills only, and still sees exactly the same shape. This page reads
 * `getBillsForManagement()` instead, which is the only thing that knows about
 * archived bills and full occurrence history.
 */

const GROUPS: { key: BillStatusKind; title: string }[] = [
  { key: "overdue", title: "Overdue" },
  { key: "due_soon", title: "Due soon" },
  { key: "upcoming", title: "Upcoming" },
];

/**
 * How many recent transactions the optional "link a payment" picker offers.
 *
 * Bounded on purpose, and small: a picker is for finding the payment you just
 * recorded, not for browsing a lifetime ledger into a form. The ordering is
 * `getTransactions()`'s own contract (`date DESC, created_at DESC, id ASC`),
 * so the list is deterministic rather than merely recent-ish.
 */
const TRANSACTION_PICKER_LIMIT = 40;

export default async function BillsPage() {
  const [bills, today, categories, accounts, recentTransactions] = await Promise.all([
    getBillsForManagement(),
    getToday(),
    getCategories(),
    getAccounts(),
    getRecentTransactions(TRANSACTION_PICKER_LIMIT),
  ]);

  const accountName = new Map(accounts.map((account) => [account.id, account.name]));

  /** A transaction, described well enough to recognise: date, merchant, amount, account. */
  const describeTransaction = (transaction: Transaction): string =>
    `${formatCalendarDate(transaction.date)} · ${transaction.merchant} · ` +
    `${formatCents(transaction.amountCents)} · ` +
    `${accountName.get(transaction.accountId) ?? "Unknown account"}`;

  const transactionLabel = new Map(
    recentTransactions.map((transaction) => [transaction.id, describeTransaction(transaction)])
  );

  const transactionOptions: TransactionOption[] = recentTransactions.map((transaction) => ({
    id: transaction.id,
    label: describeTransaction(transaction),
  }));

  // Active options only, so a form can never offer a choice `assert_bill_refs()`
  // would refuse.
  //
  // Deliberately NOT narrowed by category kind. No approved requirement says a
  // bill's category must be an expense category — `bills.category_id` carries
  // no CHECK and no document states a kind rule for it — so filtering here
  // would invent one at the UI layer that neither the database nor the
  // validation layer enforces, and would silently hide a category a person had
  // legitimately chosen for a bill.
  const categoryOptions: BillReferenceOption[] = categories
    .filter((category) => !category.isArchived)
    .map((category) => ({ id: category.id, name: category.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const accountOptions: BillReferenceOption[] = accounts
    .filter((account) => !account.isArchived)
    .map((account) => ({ id: account.id, name: account.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const actions = {
    update: updateBillAction,
    setArchived: setBillArchivedAction,
    markPaid: markBillOccurrencePaidAction,
    skip: skipBillOccurrenceAction,
    restore: restoreBillOccurrenceAction,
  };

  /**
   * `BillManagement` → the props one card needs.
   *
   * The occurrence rows carry each occurrence's *own* amount, never the
   * parent's, and a linked transaction is described only when it is one of the
   * recent ones already fetched — an older link renders as a plain note rather
   * than triggering a second query per row.
   */
  const cardFor = (bill: BillManagement) => {
    const occurrences: BillOccurrenceRow[] = bill.occurrences.map((occurrence) => ({
      id: occurrence.id,
      dueDate: occurrence.dueDate,
      status: occurrence.status,
      amountCents: occurrence.amountCents,
      paidOn: occurrence.paidOn,
      transactionLabel:
        occurrence.transactionId === undefined
          ? undefined
          : (transactionLabel.get(occurrence.transactionId) ?? "a recorded transaction"),
    }));

    // The earliest scheduled occurrence — the one Mark paid and Skip act on.
    // `getBillsForManagement()` orders newest first, so it is the last
    // scheduled row in the list, which is also how `nextDueDate` was derived.
    let nextOccurrence: BillOccurrenceRow | undefined;
    for (const occurrence of occurrences) {
      if (occurrence.status === "scheduled") nextOccurrence = occurrence;
    }

    return {
      bill: {
        id: bill.id,
        name: bill.name,
        amountCents: bill.amountCents,
        frequency: bill.frequency,
        anchorDate: bill.anchorDate,
        categoryId: bill.categoryId,
        accountId: bill.accountId,
      },
      frequency: bill.frequency,
      isArchived: bill.isArchived,
      nextDueDate: bill.nextDueDate,
      nextOccurrence,
      occurrences,
      categories: categoryOptions,
      accounts: accountOptions,
      transactions: transactionOptions,
      today,
      actions,
    };
  };

  const active = bills.filter((bill) => !bill.isArchived);
  const archived = bills.filter((bill) => bill.isArchived);

  // `billStatus()` is unchanged and remains the authority for the three
  // urgency groups. It needs a due date; an active bill with no next scheduled
  // occurrence has none, so it is grouped separately rather than given an
  // invented one that would land it under "Overdue".
  const scheduled = active.filter(
    (bill): bill is BillManagement & { nextDueDate: CalendarDate } =>
      bill.nextDueDate !== undefined
  );
  const unscheduled = active.filter((bill) => bill.nextDueDate === undefined);

  const statuses = scheduled.map((bill) => {
    // The `Bill` DTO `billStatus()` takes, projected from the management
    // shape — `dueDate` is the next scheduled occurrence, exactly as
    // `getBills()` resolves it for the narrower read.
    const projected = {
      id: bill.id,
      name: bill.name,
      amountCents: bill.amountCents,
      dueDate: bill.nextDueDate,
      frequency: bill.frequency,
      categoryId: bill.categoryId,
      accountId: bill.accountId,
    };
    const { daysUntilDue, status } = billStatus(projected, today);
    return { bill, daysUntilDue, status };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Bills" description="Upcoming and recurring bills." />

      <AddBill action={createBillAction} categories={categoryOptions} accounts={accountOptions} />

      {bills.length === 0 ? (
        <EmptyState title="No bills yet" icon={Receipt} />
      ) : (
        <>
          {GROUPS.map(({ key, title }) => {
            const group = statuses
              .filter((entry) => entry.status === key)
              .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
            if (group.length === 0) return null;

            return (
              <section key={key} className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.map((entry) => (
                    <BillCard key={entry.bill.id} status={entry.status} {...cardFor(entry.bill)} />
                  ))}
                </div>
              </section>
            );
          })}

          {unscheduled.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">No upcoming occurrence</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {unscheduled.map((bill) => (
                  <BillCard key={bill.id} {...cardFor(bill)} />
                ))}
              </div>
            </section>
          )}

          {archived.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Archived</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {archived.map((bill) => (
                  <BillCard key={bill.id} {...cardFor(bill)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
