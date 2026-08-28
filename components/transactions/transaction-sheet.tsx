"use client";

import { type ReactNode } from "react";

import { TransactionForm } from "@/components/transactions/transaction-form";
import type {
  AccountOption,
  CategoryOption,
  TransactionRow,
} from "@/components/transactions/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";

/**
 * The slide-in panel both the create and the edit surface use.
 *
 * A sheet rather than an inline disclosure, unlike `/accounts` and `/settings`:
 * this form has six controls and it is opened from a *table row*, where an
 * expanding panel would either be crammed into one cell or restructure the
 * table's row model to make space for it. A panel also gives editing and
 * creating the same shape, so nothing about the form has to know which surface
 * opened it.
 *
 * Controlled by the caller, so a successful submission can close it — the form
 * reports success upward and the parent decides. Nothing here is optimistic:
 * after a successful write the action revalidates `/transactions`, Next.js
 * re-renders the route in the same roundtrip, and the list is rebuilt from
 * fresh server data. That is why a write the server refuses leaves the UI
 * honest — nothing ever claims a change that did not happen.
 */
export function TransactionSheet({
  open,
  onOpenChange,
  title,
  description,
  action,
  accounts,
  categories,
  today,
  transaction,
  trigger,
  formKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  action: FormAction;
  accounts: readonly AccountOption[];
  categories: readonly CategoryOption[];
  today: CalendarDate;
  transaction?: TransactionRow;
  /** Rendered inside the sheet's own root so the trigger keeps its a11y wiring. */
  trigger?: ReactNode;
  /**
   * Changes to force a fresh form instance.
   *
   * On the create surface this is what mints a new idempotency key for the
   * next logical entry: `TransactionForm` generates the key once per mount, so
   * remounting is the regeneration. Stated as an explicit prop rather than
   * left to the portal's unmount-on-close behaviour, because the correctness of
   * the whole idempotency mechanism should not rest on a UI library's
   * mounting strategy.
   */
  formKey?: string | number;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger}
      <SheetContent side="right" className="overflow-y-auto p-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          {/* Keyed by the row being edited (or by the caller's instance
              counter), so opening the panel on a different row — or opening it
              again for a new entry — rebuilds the form rather than reusing the
              previous one's uncontrolled defaults, stale ActionState, and (on
              create) its already-used idempotency key. */}
          <TransactionForm
            key={transaction?.id ?? formKey ?? "new"}
            action={action}
            accounts={accounts}
            categories={categories}
            today={today}
            transaction={transaction}
            onSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
