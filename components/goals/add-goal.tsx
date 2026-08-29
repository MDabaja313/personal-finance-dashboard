"use client";

import { Plus } from "lucide-react";
import { useCallback, useState } from "react";

import { GoalForm } from "@/components/goals/goal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormAction } from "@/lib/actions/types";

/**
 * The "Add goal" disclosure at the top of `/goals` — the same collapsed-by-
 * default arrangement as `AddAccount`.
 */
export function AddGoal({ action }: { action: FormAction }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          Add goal
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New goal</CardTitle>
      </CardHeader>
      <CardContent>
        <GoalForm action={action} onSuccess={close} onCancel={close} />
      </CardContent>
    </Card>
  );
}
