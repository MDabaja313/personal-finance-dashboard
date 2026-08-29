"use client";

import { useActionState, useEffect, useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionState, FormAction } from "@/lib/actions/types";
import { formatCents, formatCentsForInput } from "@/lib/format/currency";
import { toCents, type Account, type CalendarDate } from "@/lib/types";
import { isLiabilityAccountType } from "@/lib/types/enums";

/**
 * "Reconcile balance" — say what an account's balance actually is, and let the
 * server work out the correction.
 *
 * A plain `<form>` driven by `useActionState`, with no form library, like every
 * other write surface here. Every rule deciding whether a submission is
 * acceptable lives on the server (`lib/validation/reconciliation.ts`, then the
 * mutation DAL, then `public.reconcile_account` and
 * `assert_transaction_refs()`). This component renders the controls, disables
 * submit while a request is in flight, and shows whatever the returned
 * `ActionState` says.
 *
 * ## The one thing this component decides
 *
 * Which question to ask. A checking, savings, cash or investment account is
 * reconciled against its **actual balance**, signed — an overdrawn current
 * account is a real state and has to be expressible. A credit card or a loan
 * is reconciled against the **amount currently owed**, as a plain positive
 * number, because that is what a statement says and because nobody should have
 * to know that this application stores a liability as a negative balance. The
 * negation into an internal balance happens server-side, from the account's
 * *stored* type — `isLiabilityAccountType` is imported from `lib/types/enums`
 * so the form, the schema and `lib/finance/accounts.ts` all read the same list.
 *
 * ## Why the field is prefilled with the current derived balance
 *
 * Prefilling with today's figure and submitting it unchanged reconciles to a
 * delta of zero, which writes nothing — so the safe action is also the default
 * one. It also puts the number the person is checking against their statement
 * directly in the field they are about to correct.
 *
 * That is the opposite of the account edit form's opening-balance field, which
 * is deliberately *not* prefilled: editing that figure restates history, while
 * reconciling adds a dated correction and leaves history alone.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

interface ReconcileFormProps {
  action: FormAction;
  account: Account;
  /** The owner's calendar day, from `getToday()`. The date field's default and ceiling. */
  today: CalendarDate;
  /** Called once, after a submission the server reported as successful. */
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function ReconcileForm({ action, account, today, onSuccess, onCancel }: ReconcileFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  const asOfId = useId();
  const balanceId = useId();
  const formErrorId = useId();

  // Closing the disclosure is the parent's business, and it is a state update
  // in another component — so it happens after commit, never during render.
  useEffect(() => {
    if (state.status === "success") onSuccess?.();
  }, [state, onSuccess]);

  const isLiability = isLiabilityAccountType(account.type);

  // What this account's form talks in: the amount owed for a liability (whose
  // balance is stored negative), the signed balance for everything else.
  // `|| 0` normalizes `-0`, which is `=== 0` but renders as "-0.00".
  const shownCents = isLiability ? toCents(-account.balanceCents || 0) : account.balanceCents;
  const prefill = formatCentsForInput(shownCents);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="accountId" value={account.id} />

      <p className="text-xs text-muted-foreground">
        {isLiability ? "Currently owed here: " : "Current balance here: "}
        <span className="font-medium text-foreground">{formatCents(shownCents)}</span>
      </p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={balanceId} className="text-sm font-medium text-foreground">
          {isLiability ? "Amount currently owed" : "Actual balance"}
        </label>
        <Input
          id={balanceId}
          name="balance"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={submitted?.balance ?? prefill}
          required
          disabled={pending}
          aria-invalid={errorsFor("balance").length > 0 || undefined}
          aria-describedby={errorsFor("balance").length > 0 ? `${balanceId}-error` : undefined}
        />
        <p className="text-xs text-muted-foreground">
          {isLiability
            ? "A positive amount, as your statement shows it. Enter 0 if it is paid off."
            : "Enter a negative amount if the account is overdrawn."}
        </p>
        {errorsFor("balance").length > 0 && (
          <p id={`${balanceId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("balance").join(" ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={asOfId} className="text-sm font-medium text-foreground">
          As of
        </label>
        <Input
          id={asOfId}
          name="asOf"
          type="date"
          max={today}
          defaultValue={submitted?.asOf ?? today}
          required
          disabled={pending}
          aria-invalid={errorsFor("asOf").length > 0 || undefined}
          aria-describedby={errorsFor("asOf").length > 0 ? `${asOfId}-error` : undefined}
        />
        {errorsFor("asOf").length > 0 && (
          <p id={`${asOfId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("asOf").join(" ")}
          </p>
        )}
      </div>

      {/* The whole point of the surface, said plainly: this is a correction to a
          balance, not a purchase or a payment, and nothing already recorded is
          rewritten. */}
      <p className="text-xs text-muted-foreground">
        This records a dated <span className="font-medium text-foreground">balance adjustment</span>{" "}
        for the difference, so the balance here matches reality. It is not income and not spending,
        it changes no existing transaction, and it appears in your history where you can remove it
        again. If the figures already match, nothing is recorded.
      </p>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Reconciling…" : "Reconcile"}
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
