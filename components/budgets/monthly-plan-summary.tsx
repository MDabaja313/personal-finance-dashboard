"use client";

import { useActionState, useEffect, useId, useState } from "react";

import type { MonthlyPlanActions } from "@/components/budgets/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ActionState, FormAction } from "@/lib/actions/types";
import type { MonthlyPlanSummary as PlanSummary } from "@/lib/finance/planning";
import { formatCents, formatCentsForInput } from "@/lib/format/currency";
import { formatPercent } from "@/lib/format/percent";
import type { Cents } from "@/lib/types";

/**
 * The Monthly Plan summary at the top of `/budgets` — this month's intent
 * beside this month's reality.
 *
 * ## Two columns, and the line between them is the whole point
 *
 * **Planned** is what the person decided: expected income, the sum of their
 * category budgets, and what is left unallocated. Every figure in it comes from
 * something they typed.
 *
 * **Actual** is what happened: income and spending derived from real
 * transactions, and the cash flow between them. **No control on this card can
 * change any of them**, and there is no field that could — the only editable
 * value here is expected income. Actual income in particular is
 * `monthlyIncome()` over `kind = 'income'` rows and has no relationship to the
 * target above it; a month can earn more than it planned, less, or nothing at
 * all, and the card says so rather than reconciling the two.
 *
 * ## "Not set" is a state, and it is not zero
 *
 * With no plan stored, expected income, unallocated and both percentages render
 * as "—" and the card invites a figure. Defaulting to zero would report every
 * budgeted pound as over-allocated to someone who has simply not answered yet.
 * Clearing an existing plan returns to that state, which is why Clear exists at
 * all — setting zero is a different, legitimate answer.
 *
 * All arithmetic is `lib/finance/planning.ts`'; this component renders and
 * never computes, per the `components/**` boundary.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

export function MonthlyPlanSummary({
  summary,
  monthLabel,
  actions,
}: {
  summary: PlanSummary;
  /** The month, already formatted by the route — components do no date formatting of their own. */
  monthLabel: string;
  actions: MonthlyPlanActions;
}) {
  const [editing, setEditing] = useState(false);
  const isSet = summary.expectedIncomeCents !== undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly plan · {monthLabel}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Planned
            </h3>
            <Line
              label="Expected income"
              value={
                summary.expectedIncomeCents === undefined
                  ? "—"
                  : formatCents(summary.expectedIncomeCents)
              }
            />
            <Line
              label="Planned expenses"
              value={formatCents(summary.plannedExpensesCents)}
              hint={
                summary.allocationRate === null
                  ? undefined
                  : `${formatPercent(summary.allocationRate)} of expected income`
              }
            />
            <Line
              label="Unallocated"
              value={
                summary.unallocatedCents === undefined
                  ? "—"
                  : formatCents(summary.unallocatedCents)
              }
              // Negative unallocated is a real, useful state: the budgets add
              // up to more than the month expects to earn. It is highlighted
              // rather than clamped or hidden.
              emphasis={
                summary.unallocatedCents !== undefined && summary.unallocatedCents < 0
                  ? "warn"
                  : undefined
              }
              hint={
                summary.unallocatedCents !== undefined && summary.unallocatedCents < 0
                  ? "Budgets exceed expected income."
                  : undefined
              }
            />
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Actual so far
            </h3>
            <Line
              label="Income received"
              value={formatCents(summary.actualIncomeCents)}
              hint={
                summary.incomeProgress === null
                  ? undefined
                  : `${formatPercent(summary.incomeProgress)} of expected`
              }
            />
            <Line label="Spending" value={formatCents(summary.actualSpendingCents)} />
            <Line
              label="Cash flow"
              value={formatCents(summary.actualCashFlowCents)}
              emphasis={summary.actualCashFlowCents < 0 ? "warn" : undefined}
            />
          </section>
        </div>

        <p className="text-xs text-muted-foreground">
          Income received and spending are worked out from your transactions and cannot be edited
          here. Expected income is a target only — it does not affect any account balance or your
          net worth.
        </p>

        {editing ? (
          <ExpectedIncomeForm
            action={actions.set}
            expectedIncomeCents={summary.expectedIncomeCents}
            onSuccess={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              {isSet ? "Edit expected income" : "Set expected income"}
            </Button>
            {isSet && <ClearControl action={actions.clear} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Line({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right">
        <span
          className={
            emphasis === "warn"
              ? "text-sm font-semibold text-destructive"
              : "text-sm font-semibold text-foreground"
          }
        >
          {value}
        </span>
        {hint !== undefined && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}

/**
 * Set or change the target.
 *
 * One field and one client-minted key per mounted form, exactly as every other
 * create surface here: a retry posts the same key, so it collides with itself
 * on the primary key rather than racing the `(user_id, period)` natural one.
 * The month is never a field — the Server Action derives it from the owner's
 * own calendar day.
 */
function ExpectedIncomeForm({
  action,
  expectedIncomeCents,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  expectedIncomeCents?: Cents;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [submissionKey] = useState(() => crypto.randomUUID());

  const fieldId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errors = state.fieldErrors.expectedIncome ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={submissionKey} />

      <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
        Expected income this month
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={fieldId}
          name="expectedIncome"
          inputMode="decimal"
          placeholder="0.00"
          className="w-40"
          defaultValue={
            submitted?.expectedIncome ??
            (expectedIncomeCents === undefined ? "" : formatCentsForInput(expectedIncomeCents))
          }
          required
          disabled={pending}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={errors.length > 0 ? `${fieldId}-error` : undefined}
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>

      {errors.length > 0 && (
        <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">
          {errors.join(" ")}
        </p>
      )}
      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}
    </form>
  );
}

/**
 * Clear the plan — back to "not set".
 *
 * A single submit rather than a two-step confirmation: it destroys one number
 * the person typed, touches no ledger row, no balance and no budget, and
 * re-entering it is one field. The destructive controls in this application
 * that *do* confirm all remove something derived from money.
 *
 * It posts no fields at all. The owner and the month come from the server.
 */
function ClearControl({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const errorId = useId();

  return (
    <>
      <form action={formAction}>
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Saving…" : "Clear"}
        </Button>
      </form>

      {state.formError !== null && (
        <p id={errorId} role="alert" className="basis-full text-xs text-destructive">
          {state.formError}
        </p>
      )}
    </>
  );
}
