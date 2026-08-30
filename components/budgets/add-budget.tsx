"use client";

import { Plus } from "lucide-react";
import { useActionState, useCallback, useEffect, useId, useMemo, useState } from "react";

import type { BudgetCategoryOption } from "@/components/budgets/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { optionItems } from "@/lib/ui/select-items";

/**
 * The "Add budget" disclosure at the top of `/budgets`.
 *
 * `eligibleCategories` is computed on the server: active expense categories
 * that do not already have a budget for the current month. If the list is
 * empty, the disclosure never opens onto an empty selector — it says why
 * instead, since there is nothing left to add until either a category is
 * un-archived or next month starts.
 *
 * The category and the month are the two things a budget cannot have edited
 * into it later (`lib/validation/budgets.ts`), so getting them right only
 * matters here, at create time.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

export function AddBudget({
  action,
  eligibleCategories,
}: {
  action: FormAction;
  eligibleCategories: readonly BudgetCategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (eligibleCategories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Every active expense category already has a budget this month.
      </p>
    );
  }

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          Add budget
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New budget</CardTitle>
      </CardHeader>
      <CardContent>
        <BudgetCreateForm
          action={action}
          eligibleCategories={eligibleCategories}
          onSuccess={close}
          onCancel={close}
        />
      </CardContent>
    </Card>
  );
}

function BudgetCreateForm({
  action,
  eligibleCategories,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  eligibleCategories: readonly BudgetCategoryOption[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [categoryId, setCategoryId] = useState<string>(eligibleCategories[0]?.id ?? "");

  // One key per mounted form — this component is only ever rendered while
  // the disclosure above is open, so a remount always means a new logical
  // submission. See `components/transactions/transaction-form.tsx` for the
  // full rationale this mirrors.
  const [submissionKey] = useState(() => crypto.randomUUID());

  // Base UI's `<Select.Value>` reads the Root's `items` map and falls back to
  // `String(value)` without one — which here is a raw category UUID. The
  // submitted `categoryId` is unchanged. See `lib/ui/select-items.ts`.
  const categoryLabels = useMemo(() => optionItems(eligibleCategories), [eligibleCategories]);

  const categoryFieldId = useId();
  const limitId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={submissionKey} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={categoryFieldId} className="text-sm font-medium text-foreground">
          Category
        </label>
        <Select
          name="categoryId"
          items={categoryLabels}
          value={categoryId}
          onValueChange={(value) => setCategoryId(String(value))}
          disabled={pending}
        >
          <SelectTrigger id={categoryFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {eligibleCategories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errorsFor("categoryId").length > 0 && (
          <p role="alert" className="text-xs text-destructive">
            {errorsFor("categoryId").join(" ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={limitId} className="text-sm font-medium text-foreground">
          Monthly limit
        </label>
        <Input
          id={limitId}
          name="limit"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={submitted?.limit ?? ""}
          required
          disabled={pending}
          aria-invalid={errorsFor("limit").length > 0 || undefined}
          aria-describedby={errorsFor("limit").length > 0 ? `${limitId}-error` : undefined}
        />
        {errorsFor("limit").length > 0 && (
          <p id={`${limitId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("limit").join(" ")}
          </p>
        )}
      </div>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add budget"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
