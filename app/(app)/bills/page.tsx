import { Receipt } from "lucide-react";
import { BillCard } from "@/components/bills/bill-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getBills } from "@/lib/data/bills";
import { getToday } from "@/lib/data/clock";
import { billStatus, type BillStatusKind } from "@/lib/finance/bills";

const GROUPS: { key: BillStatusKind; title: string }[] = [
  { key: "overdue", title: "Overdue" },
  { key: "due_soon", title: "Due soon" },
  { key: "upcoming", title: "Upcoming" },
];

export default async function BillsPage() {
  const [bills, today] = await Promise.all([getBills(), getToday()]);
  const statuses = bills.map((bill) => billStatus(bill, today));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Bills" description="Upcoming and recurring bills." />

      {statuses.length === 0 ? (
        <EmptyState title="No bills yet" icon={Receipt} />
      ) : (
        GROUPS.map(({ key, title }) => {
          const group = statuses
            .filter((s) => s.status === key)
            .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
          if (group.length === 0) return null;

          return (
            <section key={key} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((status) => (
                  <BillCard key={status.bill.id} status={status} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
