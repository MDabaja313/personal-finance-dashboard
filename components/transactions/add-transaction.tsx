"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { TransactionSheet } from "@/components/transactions/transaction-sheet";
import type { AccountOption, CategoryOption } from "@/components/transactions/types";
import { Button } from "@/components/ui/button";
import { SheetTrigger } from "@/components/ui/sheet";
import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";

/**
 * The "Add transaction" control at the top of `/transactions`.
 *
 * The button is the only thing this page gains in its default state; the form
 * itself lives in a sheet, so the list — which is what the page is for — keeps
 * the whole viewport. Opening it is local state and nothing more.
 */
export function AddTransaction({
  action,
  accounts,
  categories,
  today,
}: {
  action: FormAction;
  accounts: readonly AccountOption[];
  categories: readonly CategoryOption[];
  today: CalendarDate;
}) {
  const [open, setOpen] = useState(false);

  /**
   * Bumped every time the panel closes, and passed down as the form's `key`.
   *
   * That is what gives each logical entry its own idempotency key: the form
   * mints one UUID per mount, so a fresh instance means a fresh key, while
   * every retry *within* one open panel keeps the key it started with and
   * therefore collides with itself rather than inserting a second row.
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
    <TransactionSheet
      open={open}
      onOpenChange={handleOpenChange}
      formKey={formInstance}
      title="New transaction"
      description="Records something that has already happened. Transfers and card payments are entered separately."
      action={action}
      accounts={accounts}
      categories={categories}
      today={today}
      trigger={
        <SheetTrigger
          render={
            <Button type="button" variant="outline">
              <Plus aria-hidden="true" />
              Add transaction
            </Button>
          }
        />
      }
    />
  );
}
