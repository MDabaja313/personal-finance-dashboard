import { BillCardActions } from "@/components/bills/bill-card-actions";
import { BillStatusBadge } from "@/components/bills/bill-status-badge";
import type {
  BillFormValues,
  BillMutationActions,
  BillOccurrenceRow,
  BillReferenceOption,
  GeneratedPaymentPreview,
  TransactionOption,
} from "@/components/bills/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BillStatusKind } from "@/lib/finance/bills";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { BillFrequency, CalendarDate } from "@/lib/types";

/**
 * One recurring bill on `/bills`, with its management controls.
 *
 * ## The headline amount is the bill's, the history's amounts are not
 *
 * `bill.amountCents` is the parent's *current default* — what the next
 * generated occurrence will carry. Every row in the History disclosure shows
 * its own `amountCents` instead, fixed when that occurrence was generated. The
 * two are different facts about different things (docs/database-schema.md
 * §13), which is why this component never passes its own figure down.
 *
 * ## `status` stays optional
 *
 * `billStatus()` (`lib/finance/bills.ts`) remains the sole authority for
 * overdue / due soon / upcoming, unchanged by CP7. It needs a due date, and a
 * bill can legitimately have none: every occurrence paid or skipped, or the
 * bill archived. Such a card says so plainly instead of inventing a date that
 * would land it in the overdue group.
 */

const FREQUENCY_LABEL: Record<BillFrequency, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  yearly: "Every year",
};

export function BillCard({
  bill,
  frequency,
  isArchived,
  status,
  nextDueDate,
  nextOccurrence,
  occurrences,
  categories,
  accounts,
  transactions,
  generatedPayment,
  today,
  actions,
}: {
  bill: BillFormValues;
  frequency: BillFrequency;
  isArchived: boolean;
  /** Absent when the bill has no next scheduled occurrence. */
  status?: BillStatusKind;
  nextDueDate?: CalendarDate;
  nextOccurrence?: BillOccurrenceRow;
  occurrences: readonly BillOccurrenceRow[];
  categories: readonly BillReferenceOption[];
  accounts: readonly BillReferenceOption[];
  transactions: readonly TransactionOption[];
  /** What Mark paid will create when nothing is linked. Absent = status only. */
  generatedPayment?: GeneratedPaymentPreview;
  today: CalendarDate;
  actions: BillMutationActions;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{bill.name}</span>
          {status !== undefined && <BillStatusBadge status={status} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-lg font-semibold text-foreground">{formatCents(bill.amountCents)}</p>
        <p className="text-xs text-muted-foreground">
          {nextDueDate !== undefined
            ? `Due ${formatCalendarDate(nextDueDate)} · ${FREQUENCY_LABEL[frequency]}`
            : `No upcoming due date · ${FREQUENCY_LABEL[frequency]}`}
        </p>

        <BillCardActions
          bill={bill}
          isArchived={isArchived}
          nextOccurrence={nextOccurrence}
          occurrences={occurrences}
          categories={categories}
          accounts={accounts}
          transactions={transactions}
          generatedPayment={generatedPayment}
          today={today}
          actions={actions}
        />
      </CardContent>
    </Card>
  );
}
