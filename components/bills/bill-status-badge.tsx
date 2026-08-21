import { AlertCircle, CalendarClock, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BillStatusKind } from "@/lib/finance/bills";

const CONFIG: Record<
  BillStatusKind,
  { label: string; variant: "destructive" | "secondary" | "outline"; icon: typeof AlertCircle }
> = {
  overdue: { label: "Overdue", variant: "destructive", icon: AlertCircle },
  due_soon: { label: "Due soon", variant: "secondary", icon: Clock },
  upcoming: { label: "Upcoming", variant: "outline", icon: CalendarClock },
};

/** Status is conveyed by icon + text, never by color alone. */
export function BillStatusBadge({ status }: { status: BillStatusKind }) {
  const { label, variant, icon: Icon } = CONFIG[status];
  return (
    <Badge variant={variant} className="gap-1">
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
