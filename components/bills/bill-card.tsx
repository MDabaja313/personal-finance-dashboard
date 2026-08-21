import { BillStatusBadge } from "@/components/bills/bill-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BillStatus } from "@/lib/finance/bills";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { BillFrequency } from "@/lib/types";

const FREQUENCY_LABEL: Record<BillFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

export function BillCard({ status }: { status: BillStatus }) {
  const { bill } = status;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{bill.name}</span>
          <BillStatusBadge status={status.status} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-lg font-semibold text-foreground">{formatCents(bill.amountCents)}</p>
        <p className="text-xs text-muted-foreground">
          Due {formatCalendarDate(bill.dueDate)} · {FREQUENCY_LABEL[bill.frequency]}
        </p>
      </CardContent>
    </Card>
  );
}
