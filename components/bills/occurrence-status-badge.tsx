import { CalendarClock, Check, SkipForward } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { BillOccurrenceStatus } from "@/lib/types";

const CONFIG: Record<
  BillOccurrenceStatus,
  { label: string; variant: "secondary" | "outline"; icon: typeof Check }
> = {
  scheduled: { label: "Scheduled", variant: "outline", icon: CalendarClock },
  paid: { label: "Paid", variant: "secondary", icon: Check },
  skipped: { label: "Skipped", variant: "outline", icon: SkipForward },
};

/**
 * The three occurrence states, conveyed by icon + text and never by color
 * alone — the same rule `BillStatusBadge` follows.
 *
 * Deliberately a different component from `BillStatusBadge`, which reports
 * overdue/due-soon/upcoming for a *bill* from its next due date. The two
 * answer different questions about different rows and share no vocabulary:
 * a scheduled occurrence can be overdue, and a paid one has no urgency at all.
 */
export function OccurrenceStatusBadge({ status }: { status: BillOccurrenceStatus }) {
  const { label, variant, icon: Icon } = CONFIG[status];
  return (
    <Badge variant={variant} className="gap-1">
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
