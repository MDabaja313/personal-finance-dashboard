import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  CreditCard,
  RotateCcw,
  Scale,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { TransactionKind } from "@/lib/types";
import { isMovementKind } from "@/lib/types/enums";
import { cn } from "@/lib/utils";

const CONFIG: Record<
  TransactionKind,
  { label: string; icon: typeof ArrowDownLeft; variant: "default" | "secondary" | "outline" }
> = {
  income: { label: "Income", icon: ArrowDownLeft, variant: "default" },
  expense: { label: "Expense", icon: ArrowUpRight, variant: "secondary" },
  refund: { label: "Refund", icon: RotateCcw, variant: "secondary" },
  transfer: { label: "Transfer", icon: ArrowLeftRight, variant: "outline" },
  credit_card_payment: { label: "Card Payment", icon: CreditCard, variant: "outline" },
  // A reconciliation correction, not an economic event — muted alongside the
  // movement kinds for the same reason: none of the three is spending or
  // income, and the badge is where that distinction is easiest to read.
  adjustment: { label: "Adjustment", icon: Scale, variant: "outline" },
};

/**
 * Kind is conveyed by icon + text, never by color alone. Transfers, card
 * payments and adjustments are visually muted to reinforce that they aren't
 * spending.
 *
 * A `Record` over the full `TransactionKind` union rather than a lookup with a
 * fallback: adding a kind to the enum without deciding how it reads is a type
 * error here, which is exactly when that decision should be forced.
 */
export function KindBadge({ kind }: { kind: TransactionKind }) {
  const { label, icon: Icon, variant } = CONFIG[kind];
  const isNonEconomic = isMovementKind(kind) || kind === "adjustment";

  return (
    <Badge variant={variant} className={cn("gap-1", isNonEconomic && "text-muted-foreground")}>
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
