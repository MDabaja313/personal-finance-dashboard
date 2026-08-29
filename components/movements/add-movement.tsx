"use client";

import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";

import { MovementSheet } from "@/components/movements/movement-sheet";
import type { MovementAccountOption } from "@/components/movements/types";
import { Button } from "@/components/ui/button";
import { SheetTrigger } from "@/components/ui/sheet";
import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";

/**
 * The "Move money" control at the top of `/transactions`, beside "Add
 * transaction".
 *
 * A second, separate entry point rather than a fourth option on the ordinary
 * type picker. That separation is not cosmetic: an ordinary transaction is one
 * row in one account with a merchant and a category, and a movement is a pair
 * of rows across two accounts with neither. Folding them into one form would
 * mean a control whose visible fields changed identity halfway down, and
 * `lib/validation/transactions.ts` would still have to refuse the movement
 * kinds — which is exactly why the two schemas are separate objects rather than
 * one list with a filter.
 *
 * Both movement kinds live behind this one button, chosen with the form's own
 * Type control, because they differ in wording and in which destinations are
 * offered rather than in shape.
 */
export function AddMovement({
  action,
  accounts,
  today,
}: {
  action: FormAction;
  accounts: readonly MovementAccountOption[];
  today: CalendarDate;
}) {
  const [open, setOpen] = useState(false);

  /**
   * Bumped every time the panel closes, and passed down as the form's `key`.
   *
   * That is what gives each logical movement its own idempotency keys: the form
   * mints one movement UUID and one UUID per leg per mount, so a fresh instance
   * means fresh keys, while every retry *within* one open panel keeps the keys
   * it started with and therefore collides with itself rather than writing a
   * second transfer.
   *
   * Done in the change handler, which is an event — not in an effect reacting
   * to `open`, which would re-render for nothing on every open as well.
   */
  const [formInstance, setFormInstance] = useState(0);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) setFormInstance((instance) => instance + 1);
  }

  return (
    <MovementSheet
      open={open}
      onOpenChange={handleOpenChange}
      formKey={formInstance}
      title="Move money"
      description="A transfer or a credit card payment. Both accounts are yours, so nothing here counts as income or spending."
      action={action}
      accounts={accounts}
      today={today}
      trigger={
        <SheetTrigger
          render={
            <Button type="button" variant="outline">
              <ArrowLeftRight aria-hidden="true" />
              Move money
            </Button>
          }
        />
      }
    />
  );
}
