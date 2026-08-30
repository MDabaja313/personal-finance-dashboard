"use client";

import { Plus } from "lucide-react";
import { useCallback, useState } from "react";

import { BillForm } from "@/components/bills/bill-form";
import type { BillReferenceOption } from "@/components/bills/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormAction } from "@/lib/actions/types";

/**
 * The "Add bill" disclosure at the top of `/bills`.
 *
 * The same shape as `AddBudget` and `AddGoal`: a button until it is opened, a
 * card containing the form afterwards, and the form unmounts on close — which
 * is what gives each logical submission its own idempotency key.
 *
 * The category and account lists are computed on the server and are active
 * options only, so the form can never offer a choice `assert_bill_refs()` would
 * refuse. Neither list is narrowed by category kind: a bill's category is a
 * label, and no approved requirement restricts it to expense categories.
 */
export function AddBill({
  action,
  categories,
  accounts,
}: {
  action: FormAction;
  categories: readonly BillReferenceOption[];
  accounts: readonly BillReferenceOption[];
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          Add bill
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New bill</CardTitle>
      </CardHeader>
      <CardContent>
        <BillForm
          action={action}
          categories={categories}
          accounts={accounts}
          onSuccess={close}
          onCancel={close}
        />
      </CardContent>
    </Card>
  );
}
