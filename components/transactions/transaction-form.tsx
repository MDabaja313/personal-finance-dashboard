"use client";

import { useActionState, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import type {
  AccountOption,
  CategoryOption,
  TransactionRow,
} from "@/components/transactions/types";
import { INITIAL_ACTION_STATE } from "@/components/transactions/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FormAction } from "@/lib/actions/types";
import type { CalendarDate } from "@/lib/types";
import {
  ORDINARY_TRANSACTION_KINDS,
  categoryKindFor,
  type OrdinaryTransactionKind,
} from "@/lib/types/enums";

/**
 * The transaction create/edit form.
 *
 * A plain `<form>` driven by `useActionState`, with no form library: the action
 * receives the real `FormData`, and every rule deciding whether a submission is
 * acceptable lives on the server (`lib/validation/transactions.ts`, then the
 * mutation DAL's preflights, then `assert_transaction_refs()`). This
 * component's jobs are to render the controls, keep a person from being offered
 * a choice the server would refuse, disable submit while a request is in
 * flight, and show whatever the returned `ActionState` says.
 *
 * The action arrives as a prop rather than an import — `components/**` is
 * fenced away from value imports of `lib/actions/**`, and the route is the
 * seam. Only types are imported, and a type import is erased at compile time.
 *
 * ## The amount field is a magnitude
 *
 * There is no minus sign to type and no sign to get wrong: the field collects
 * "how much", the `Type` control says which direction, and the server derives
 * the stored sign with `signedAmountFor`. On edit the field is prefilled with
 * the stored amount's *magnitude* for the same reason — the row already knows
 * it was an expense.
 *
 * ## The category picker narrows itself to the selected kind
 *
 * `categoryKindFor` is the same predicate the mutation preflight and
 * `assert_transaction_refs()` use, imported from `lib/types/enums.ts` where all
 * three layers can reach it. Changing the kind to one the current category
 * cannot serve clears the selection rather than leaving an invisible invalid
 * value staged for submission.
 *
 * Archived accounts and categories never appear: the page passes active ones
 * only. An archived option would be a control that always fails, and
 * "unarchive it first" is the rule the database states too.
 */

const KIND_LABELS: Record<OrdinaryTransactionKind, string> = {
  income: "Income",
  expense: "Expense",
  refund: "Refund",
};

const UNCATEGORIZED = "none";

/**
 * Cents → the decimal string a money input should start with.
 *
 * Integer division and a padded remainder, never `cents / 100` — the same
 * reason `lib/validation/money.ts` refuses to build a float on the way in. The
 * sign is dropped deliberately: this field is a magnitude.
 */
function magnitudeToInput(cents: number): string {
  const magnitude = Math.abs(cents);
  return `${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

interface TransactionFormProps {
  action: FormAction;
  accounts: readonly AccountOption[];
  categories: readonly CategoryOption[];
  /** The owner's calendar day — the date field's default and its ceiling. */
  today: CalendarDate;
  /** Absent = create. Present = edit that transaction. */
  transaction?: TransactionRow;
  /** Called once, after a submission the server reported as successful. */
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function TransactionForm({
  action,
  accounts,
  categories,
  today,
  transaction,
  onSuccess,
  onCancel,
}: TransactionFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_ACTION_STATE);

  const isEdit = transaction !== undefined;

  const initialKind: OrdinaryTransactionKind =
    isEdit && isOrdinary(transaction.kind) ? transaction.kind : "expense";

  const [kind, setKind] = useState<OrdinaryTransactionKind>(initialKind);
  const [categoryId, setCategoryId] = useState<string>(transaction?.categoryId ?? UNCATEGORIZED);
  const [accountId, setAccountId] = useState<string>(
    transaction?.accountId ?? accounts[0]?.id ?? ""
  );

  /**
   * The idempotency key, on create only.
   *
   * One key per *mounted form*, generated once by a lazy `useState` initializer
   * and never changed while the form is on screen. That is precisely the
   * lifetime the key needs:
   *
   * - Every retry of the same visible form — a double click, a resubmit after
   *   a validation failure, a resubmit after a response was lost in flight —
   *   posts the *same* key, so the second attempt collides with the first on
   *   the primary key instead of inserting a second row. The lost-response
   *   case is the one that matters most: the row was written, the person never
   *   saw the confirmation, and pressing the button again is the only sensible
   *   thing they can do.
   * - A *new* logical entry gets a new key, because the panel unmounts when it
   *   closes and `AddTransaction` remounts the form for the next one. A
   *   deliberate remount rather than a bare reliance on the portal's
   *   behaviour — see `TransactionSheet`'s `formKey`.
   *
   * No `useEffect` and no post-success mutation of the key: regenerating in
   * place would mean a window in which the form is on screen with a key that
   * no longer matches the submission the person is watching.
   *
   * `crypto.randomUUID()` during render is safe here because this form is only
   * ever mounted inside an open sheet — a client-side portal that does not
   * server-render — so there is no server HTML for the hidden input to
   * disagree with.
   */
  const [submissionKey] = useState<string | null>(() => (isEdit ? null : crypto.randomUUID()));

  const accountFieldId = useId();
  const dateId = useId();
  const merchantId = useId();
  const kindId = useId();
  const categoryFieldId = useId();
  const amountId = useId();
  const formErrorId = useId();

  // Closing the panel is the parent's business, and it is a state update in
  // another component — so it happens after commit, never during render.
  useEffect(() => {
    if (state.status === "success") onSuccess?.();
  }, [state, onSuccess]);

  const availableCategories = useMemo(
    () => categories.filter((category) => category.kind === categoryKindFor(kind)),
    [categories, kind]
  );

  /**
   * Changing the kind can strand a category the new kind cannot serve — an
   * expense category on an income row. Clearing it here, in the event handler
   * that caused it, rather than in an effect reacting to the result: the
   * effect version re-renders twice and briefly shows a picker displaying a
   * value that is not in its own option list.
   */
  function changeKind(next: OrdinaryTransactionKind): void {
    setKind(next);
    if (categoryId === UNCATEGORIZED) return;
    const stillValid = categories.some(
      (category) => category.id === categoryId && category.kind === categoryKindFor(next)
    );
    if (!stillValid) setCategoryId(UNCATEGORIZED);
  }

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  // Create needs a key before it can be submitted at all. Every other
  // disabled-state is just "a request is in flight".
  const submitDisabled = pending || (!isEdit && submissionKey === null) || accounts.length === 0;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {isEdit ? (
        <input type="hidden" name="id" value={transaction.id} />
      ) : (
        submissionKey !== null && <input type="hidden" name="id" value={submissionKey} />
      )}

      {/* Account and Type carry `name`, so the Select primitive emits their
          hidden input itself — the same arrangement AccountForm uses. Category
          cannot: its "Uncategorized" option needs an empty value in the
          FormData, and an empty item value is not something a Select can hold,
          so the sentinel is translated here instead. */}
      <input
        type="hidden"
        name="categoryId"
        value={categoryId === UNCATEGORIZED ? "" : categoryId}
      />

      <Field id={accountFieldId} label="Account" errors={errorsFor("accountId")}>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add an account before entering transactions.
          </p>
        ) : (
          <Select
            name="accountId"
            value={accountId}
            onValueChange={(value) => setAccountId(String(value))}
            disabled={pending}
          >
            <SelectTrigger id={accountFieldId} className="w-full">
              <SelectValue placeholder="Select an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Field id={kindId} label="Type" errors={errorsFor("kind")}>
        <Select
          name="kind"
          value={kind}
          onValueChange={(value) => changeKind(value as OrdinaryTransactionKind)}
          disabled={pending}
        >
          <SelectTrigger id={kindId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORDINARY_TRANSACTION_KINDS.map((option) => (
              <SelectItem key={option} value={option}>
                {KIND_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id={merchantId} label="Merchant" errors={errorsFor("merchant")}>
        <Input
          id={merchantId}
          name="merchant"
          defaultValue={submitted?.merchant ?? transaction?.merchant ?? ""}
          required
          maxLength={120}
          disabled={pending}
          aria-invalid={errorsFor("merchant").length > 0 || undefined}
          aria-describedby={errorsFor("merchant").length > 0 ? `${merchantId}-error` : undefined}
        />
      </Field>

      <Field
        id={amountId}
        label="Amount"
        hint="How much — the type above decides the direction. Enter it without a minus sign."
        errors={errorsFor("amount")}
      >
        <Input
          id={amountId}
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={
            submitted?.amount ??
            (transaction ? magnitudeToInput(transaction.amountCents) : "")
          }
          required
          disabled={pending}
          aria-invalid={errorsFor("amount").length > 0 || undefined}
          aria-describedby={errorsFor("amount").length > 0 ? `${amountId}-error` : undefined}
        />
      </Field>

      <Field
        id={dateId}
        label="Date"
        hint="A transaction records something that has already happened, so it cannot be dated ahead of today."
        errors={errorsFor("date")}
      >
        <Input
          id={dateId}
          name="date"
          type="date"
          // The browser's own ceiling, matching the server's. It is a
          // convenience only — `zNotFuture(today)` and
          // assert_transaction_refs() are what actually enforce it.
          max={today}
          defaultValue={submitted?.date ?? transaction?.date ?? today}
          required
          disabled={pending}
          aria-invalid={errorsFor("date").length > 0 || undefined}
          aria-describedby={errorsFor("date").length > 0 ? `${dateId}-error` : undefined}
        />
      </Field>

      <Field
        id={categoryFieldId}
        label="Category"
        hint="Optional — an uncategorized transaction is fine."
        errors={errorsFor("categoryId")}
      >
        <Select
          value={categoryId}
          onValueChange={(value) => setCategoryId(String(value))}
          disabled={pending}
        >
          <SelectTrigger id={categoryFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNCATEGORIZED}>Uncategorized</SelectItem>
            {availableCategories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={submitDisabled}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add transaction"}
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

/** Narrows a stored row's kind to the three the form can represent. */
function isOrdinary(kind: TransactionRow["kind"]): kind is OrdinaryTransactionKind {
  return (ORDINARY_TRANSACTION_KINDS as readonly string[]).includes(kind);
}

/** Label + control + optional hint + this field's messages, in one place. */
function Field({
  id,
  label,
  hint,
  errors,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  errors: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {errors.length > 0 && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {errors.join(" ")}
        </p>
      )}
    </div>
  );
}
