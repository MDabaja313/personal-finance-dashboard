import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CreditCard, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { TransactionKind } from "@/lib/types";
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
};

/**
 * Kind is conveyed by icon + text, never by color alone. Transfers and
 * credit-card payments are visually muted to reinforce that they aren't spending.
 */
export function KindBadge({ kind }: { kind: TransactionKind }) {
  const { label, icon: Icon, variant } = CONFIG[kind];
  const isMovement = kind === "transfer" || kind === "credit_card_payment";

  return (
    <Badge variant={variant} className={cn("gap-1", isMovement && "text-muted-foreground")}>
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
