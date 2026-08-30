"use client";

import { type ReactNode } from "react";

import { MovementForm } from "@/components/movements/movement-form";
import type { MovementAccountOption, MovementEditRow } from "@/components/movements/types";
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
 * The slide-in panel both the create and the edit movement surface use.
 *
 * A sheet, matching `TransactionSheet` — the two forms open from the same page
 * and one of them opens from a *table row*, where an expanding panel would
 * either be crammed into one cell or restructure the table's row model to make
 * space for it.
 *
 * Controlled by the caller, so a successful submission can close it — the form
 * reports success upward and the parent decides. Nothing here is optimistic:
 * after a successful write the action revalidates `/transactions`, Next.js
 * re-renders the route in the same roundtrip, and the list is rebuilt from
 * fresh server data. That is why a write the server refuses leaves the UI
 * honest — nothing ever claims a change that did not happen, and a rejected
 * edit leaves both original legs exactly where they were.
 */
export function MovementSheet({
  open,
  onOpenChange,
  title,
  description,
  action,
  accounts,
  today,
  movement,
  trigger,
  formKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  action: FormAction;
  accounts: readonly MovementAccountOption[];
  today: CalendarDate;
  movement?: MovementEditRow;
  /** Rendered inside the sheet's own root so the trigger keeps its a11y wiring. */
  trigger?: ReactNode;
  /**
   * Changes to force a fresh form instance.
   *
   * On the create surface this is what mints new idempotency keys for the next
   * logical movement: `MovementForm` generates all three ids once per mount, so
   * remounting is the regeneration. Stated as an explicit prop rather than left
   * to the portal's unmount-on-close behaviour, because the correctness of the
   * whole idempotency mechanism should not rest on a UI library's mounting
   * strategy.
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
          {/* Keyed by the movement being edited (or by the caller's instance
              counter), so opening the panel on a different movement — or
              opening it again for a new one — rebuilds the form rather than
              reusing the previous one's uncontrolled defaults, stale
              ActionState, and (on create) its already-used idempotency keys. */}
          <MovementForm
            key={movement?.id ?? formKey ?? "new"}
            action={action}
            accounts={accounts}
            today={today}
            movement={movement}
            onSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
