"use client";

import { useActionState, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import type { BillFormValues, BillReferenceOption } from "@/components/bills/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { formatCentsForInput } from "@/lib/format/currency";
import type { BillFrequency } from "@/lib/types";
import { BILL_FREQUENCIES } from "@/lib/types/enums";
import { optionItems, selectItems } from "@/lib/ui/select-items";

/**
 * The bill create/edit form.
 *
 * A plain `<form>` driven by `useActionState`, with no form library — the same
 * arrangement `GoalForm` and `AccountForm` use, and for the same reason: every
 * rule deciding whether a submission is acceptable lives on the server
 * (`lib/validation/bills.ts`, then `assert_bill_refs()` and the column-scoped
 * grant).
 *
 * Two things about the fields are worth stating outright, because they are the
 * parts a person can get wrong in a way that matters:
 *
 * - **"First due date" is the anchor**, and the whole recurrence derives from
 *   it — a monthly bill anchored on the 31st falls due on the last day of
 *   every shorter month and returns to the 31st afterwards, never drifting.
 *   The label says "first due date" rather than "anchor" because that is what
 *   it means to the person filling it in.
 * - **Editing the amount, the schedule or the first due date rebuilds the
 *   future**, and nothing else. The hint under the form says so, because the
 *   alternative is someone changing a price and wondering whether their paid
 *   history just changed too. It did not, and cannot.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

/** Plain-language recurrence labels — never the raw enum label. */
const FREQUENCY_LABEL: Record<BillFrequency, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  yearly: "Every year",
};

/** The sentinel a `<select>` uses for "none" — an empty option value is not selectable. */
const NONE = "none";

interface BillFormProps {
  action: FormAction;
  /** Absent = create. Present = edit that bill. */
  bill?: BillFormValues;
  /** Active categories only. Kind is deliberately unconstrained for a bill. */
  categories: readonly BillReferenceOption[];
  /** Active accounts only. */
  accounts: readonly BillReferenceOption[];
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function BillForm({
  action,
  bill,
  categories,
  accounts,
  onSuccess,
  onCancel,
}: BillFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const isEdit = bill !== undefined;

  // One key per mounted form, created only on the create path — the same
  // lifetime every other create form in this application relies on: this
  // component is only ever mounted fresh inside a disclosure that unmounts on
  // close, so a remount always means a new logical submission.
  const [submissionKey] = useState<string | null>(() => (isEdit ? null : crypto.randomUUID()));

  const [frequency, setFrequency] = useState<BillFrequency>(bill?.frequency ?? "monthly");
  const [categoryId, setCategoryId] = useState<string>(bill?.categoryId ?? NONE);
  const [accountId, setAccountId] = useState<string>(bill?.accountId ?? NONE);

  // Base UI's `<Select.Value>` reads the Root's `items` map and falls back to
  // `String(value)` without one — a raw UUID for the category and account
  // pickers, and the wire label for the frequency. Every submitted value is
  // unchanged. See `lib/ui/select-items.ts`.
  const frequencyLabels = useMemo(
    () =>
      selectItems(BILL_FREQUENCIES.map((option) => ({ value: option, label: FREQUENCY_LABEL[option] }))),
    []
  );
  const categoryLabels = useMemo(
    () => optionItems(categories, { value: NONE, label: "No category" }),
    [categories]
  );
  const accountLabels = useMemo(
    () => optionItems(accounts, { value: NONE, label: "No account" }),
    [accounts]
  );

  const nameId = useId();
  const amountId = useId();
  const frequencyId = useId();
  const anchorId = useId();
  const categoryFieldId = useId();
  const accountFieldId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess?.();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];
  const submitDisabled = pending || (!isEdit && submissionKey === null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {isEdit ? (
        <input type="hidden" name="id" value={bill.id} />
      ) : (
        submissionKey !== null && <input type="hidden" name="id" value={submissionKey} />
      )}

      {/* The three selects post through hidden inputs: the shadcn Select is a
          controlled component, not a native <select>, so its value is not part
          of the form on its own. */}
      <input type="hidden" name="frequency" value={frequency} />
      <input type="hidden" name="categoryId" value={categoryId === NONE ? "" : categoryId} />
      <input type="hidden" name="accountId" value={accountId === NONE ? "" : accountId} />

      <Field id={nameId} label="Name" errors={errorsFor("name")}>
        <Input
          id={nameId}
          name="name"
          defaultValue={submitted?.name ?? bill?.name ?? ""}
          required
          maxLength={120}
          disabled={pending}
          aria-invalid={errorsFor("name").length > 0 || undefined}
          aria-describedby={errorsFor("name").length > 0 ? `${nameId}-error` : undefined}
        />
      </Field>

      <Field id={amountId} label="Amount" errors={errorsFor("amount")}>
        <Input
          id={amountId}
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={submitted?.amount ?? (bill ? formatCentsForInput(bill.amountCents) : "")}
          required
          disabled={pending}
          aria-invalid={errorsFor("amount").length > 0 || undefined}
          aria-describedby={errorsFor("amount").length > 0 ? `${amountId}-error` : undefined}
        />
      </Field>

      <Field id={frequencyId} label="Repeats" errors={errorsFor("frequency")}>
        <Select
          items={frequencyLabels}
          value={frequency}
          onValueChange={(value) => setFrequency(value as BillFrequency)}
          disabled={pending}
        >
          <SelectTrigger id={frequencyId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BILL_FREQUENCIES.map((option) => (
              <SelectItem key={option} value={option}>
                {FREQUENCY_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id={anchorId} label="First due date" errors={errorsFor("anchorDate")}>
        <Input
          id={anchorId}
          name="anchorDate"
          type="date"
          defaultValue={submitted?.anchorDate ?? bill?.anchorDate ?? ""}
          required
          disabled={pending}
          aria-invalid={errorsFor("anchorDate").length > 0 || undefined}
          aria-describedby={errorsFor("anchorDate").length > 0 ? `${anchorId}-error` : undefined}
        />
        <p className="text-xs text-muted-foreground">
          Every later due date is worked out from this one, so a bill due on the 31st still falls on
          the last day of shorter months.
        </p>
      </Field>

      <Field id={categoryFieldId} label="Category (optional)" errors={errorsFor("categoryId")}>
        <Select
          items={categoryLabels}
          value={categoryId}
          onValueChange={(value) => setCategoryId(String(value))}
          disabled={pending}
        >
          <SelectTrigger id={categoryFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No category</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id={accountFieldId} label="Account (optional)" errors={errorsFor("accountId")}>
        <Select
          items={accountLabels}
          value={accountId}
          onValueChange={(value) => setAccountId(String(value))}
          disabled={pending}
        >
          <SelectTrigger id={accountFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No account</SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {isEdit && (
        <p className="text-xs text-muted-foreground">
          Changing the amount, how often it repeats, or the first due date rebuilds the upcoming
          schedule. Occurrences you have already paid or skipped keep their own amounts and dates.
        </p>
      )}

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={submitDisabled}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add bill"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  errors,
  children,
}: {
  id: string;
  label: string;
  errors: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {errors.length > 0 && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {errors.join(" ")}
        </p>
      )}
    </div>
  );
}
