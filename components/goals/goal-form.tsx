"use client";

import { useActionState, useEffect, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { formatCentsForInput } from "@/lib/format/currency";
import type { Goal } from "@/lib/types";

/**
 * The goal create/edit form.
 *
 * A plain `<form>` driven by `useActionState`, with no form library — the
 * same arrangement `AccountForm` uses, and for the same reason: every rule
 * deciding whether a submission is acceptable lives on the server
 * (`lib/validation/goals.ts`, then `goals_target_positive_ck`).
 *
 * The target may be edited below the currently saved amount — an
 * over-funded goal is already a supported, displayed state
 * (`goalProgress()` reports progress over 100%) — and editing works
 * identically whether the goal is active or archived, since neither touches
 * a single contribution row.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

interface GoalFormProps {
  action: FormAction;
  /** Absent = create. Present = edit that goal. */
  goal?: Goal;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function GoalForm({ action, goal, onSuccess, onCancel }: GoalFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const isEdit = goal !== undefined;

  // One key per mounted form, created only on the create path — the same
  // lifetime `AccountForm`/`TransactionForm` rely on: this component is only
  // ever mounted fresh inside a disclosure that unmounts on close.
  const [submissionKey] = useState<string | null>(() => (isEdit ? null : crypto.randomUUID()));

  const nameId = useId();
  const targetId = useId();
  const targetDateId = useId();
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
        <input type="hidden" name="id" value={goal.id} />
      ) : (
        submissionKey !== null && <input type="hidden" name="id" value={submissionKey} />
      )}

      <Field id={nameId} label="Name" errors={errorsFor("name")}>
        <Input
          id={nameId}
          name="name"
          defaultValue={submitted?.name ?? goal?.name ?? ""}
          required
          maxLength={120}
          disabled={pending}
          aria-invalid={errorsFor("name").length > 0 || undefined}
          aria-describedby={errorsFor("name").length > 0 ? `${nameId}-error` : undefined}
        />
      </Field>

      <Field id={targetId} label="Target amount" errors={errorsFor("target")}>
        <Input
          id={targetId}
          name="target"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={submitted?.target ?? (goal ? formatCentsForInput(goal.targetCents) : "")}
          required
          disabled={pending}
          aria-invalid={errorsFor("target").length > 0 || undefined}
          aria-describedby={errorsFor("target").length > 0 ? `${targetId}-error` : undefined}
        />
      </Field>

      <Field id={targetDateId} label="Target date (optional)" errors={errorsFor("targetDate")}>
        <Input
          id={targetDateId}
          name="targetDate"
          type="date"
          defaultValue={submitted?.targetDate ?? goal?.targetDate ?? ""}
          disabled={pending}
          aria-invalid={errorsFor("targetDate").length > 0 || undefined}
          aria-describedby={errorsFor("targetDate").length > 0 ? `${targetDateId}-error` : undefined}
        />
      </Field>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={submitDisabled}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add goal"}
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
