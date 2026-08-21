import Link from "next/link";
import { BillStatusBadge } from "@/components/bills/bill-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { BillStatus } from "@/lib/finance/bills";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";

export function UpcomingBills({ statuses }: { statuses: BillStatus[] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Upcoming Bills</CardTitle>
        <Link href="/bills" className="text-xs font-medium text-primary hover:underline">
          View all →
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col">
        {statuses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills due soon.</p>
        ) : (
          statuses.map((status, index) => (
            <div key={status.bill.id}>
              {index > 0 && <Separator className="my-3" />}
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{status.bill.name}</p>
                  <p className="text-xs text-muted-foreground">Due {formatCalendarDate(status.bill.dueDate)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {formatCents(status.bill.amountCents)}
                  </span>
                  <BillStatusBadge status={status.status} />
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
