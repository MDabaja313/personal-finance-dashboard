"use client";

import { Plus } from "lucide-react";
import { useCallback, useState } from "react";

import { AccountForm } from "@/components/accounts/account-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormAction } from "@/lib/actions/types";

/**
 * The "Add account" disclosure at the top of `/accounts`.
 *
 * Collapsed by default: the page's job is to show what you have, and a form
 * permanently occupying the first screen would push that below the fold on a
 * phone. Opening it is local state and nothing more — the form itself is
 * `AccountForm`, identical to the one used for editing.
 */
export function AddAccount({ action }: { action: FormAction }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          Add account
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New account</CardTitle>
      </CardHeader>
      <CardContent>
        <AccountForm action={action} onSuccess={close} onCancel={close} />
      </CardContent>
    </Card>
  );
}
