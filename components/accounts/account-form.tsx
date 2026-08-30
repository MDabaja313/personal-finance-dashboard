"use client";

import { useActionState, useEffect, useId, useState, type ReactNode } from "react";

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
import type { Account, AccountType, Cents } from "@/lib/types";
import { allowsCreditLimit, allowsInterestRate } from "@/lib/types/enums";
import { selectItems } from "@/lib/ui/select-items";

/**
 * The account create/edit form.
 *
 * A plain `<form>` driven by `useActionState`, with no form library: the action
 * receives the real `FormData`, and every rule deciding whether a submission is
 * acceptable lives on the server (`lib/validation/accounts.ts`, then the
 * mutation DAL, then the database). This component's jobs are to render the
 * controls, disable submit while a request is in flight, and show whatever the
 * returned `ActionState` says — nothing else.
 *
 * The action arrives as a prop rather than an import — the same arrangement
 * `components/auth/login-form.tsx` uses, and the reason `components/**` is
 * fenced away from value imports of `lib/actions/**`. Only types are imported,
 * and a type import is erased at compile time.
 *
 * ## Which fields exist depends on the account type
 *
 * A credit limit is legal only on a `credit` account and an interest rate only
 * on `credit`/`loan` — `accounts_credit_limit_domain_ck` and
 * `accounts_interest_rate_domain_ck` say so in the database. Rather than
 * restate that rule in JSX, this imports the same two predicates the schema
 * uses, from `lib/types/enums.ts` where both layers can reach them. On create
 * the type is local state, so the fields appear the moment a type is chosen; on
 * edit the type is fixed (immutable, and not in the CP2 UPDATE grant) and is
 * rendered as text.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

const ACCOUNT_TYPE_OPTIONS: { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "cash", label: "Cash" },
  { value: "credit", label: "Credit Card" },
  { value: "investment", label: "Investment" },
  { value: "loan", label: "Loan" },
];

const ACCOUNT_TYPE_LABEL = new Map(ACCOUNT_TYPE_OPTIONS.map((option) => [option.value, option.label]));

/**
 * The same labels, as the `items` map Base UI's `<Select.Value>` reads.
 *
 * Without it the trigger renders `String(value)` — the wire label `checking`
 * rather than `Checking`, and on the UUID-backed selectors elsewhere in this
 * application a raw id. Module scope rather than a `useMemo`: the option list
 * is a constant. See `lib/ui/select-items.ts`.
 */
const ACCOUNT_TYPE_ITEMS = selectItems(ACCOUNT_TYPE_OPTIONS);

/**
 * Cents → the decimal string a money input should start with, or `""` when
 * there is no stored value to prefill.
 *
 * The conversion itself is `formatCentsForInput` in `lib/format/currency.ts`,
 * which is the one place a `Cents` value becomes a decimal (and the one place
 * that keeps the float out of it). All that is left here is the
 * "nothing to prefill" case, which is a form concern rather than a formatting
 * one.
 */
function centsToInput(cents: Cents | undefined): string {
  return cents === undefined ? "" : formatCentsForInput(cents);
}

/** Basis points → the percentage string the rate input should start with. */
function bpsToInput(bps: number | undefined): string {
  if (bps === undefined) return "";
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
}

interface AccountFormProps {
  action: FormAction;
  /** Absent = create. Present = edit that account. */
  account?: Account;
  /** Called once, after a submission the server reported as successful. */
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function AccountForm({ action, account, onSuccess, onCancel }: AccountFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  const isEdit = account !== undefined;
  const [type, setType] = useState<AccountType>(account?.type ?? "checking");

  const nameId = useId();
  const institutionId = useId();
  const typeId = useId();
  const openingBalanceId = useId();
  const creditLimitId = useId();
  const interestRateId = useId();
  const formErrorId = useId();

  // Closing the disclosure is the parent's business, and it is a state update
  // in another component — so it happens after commit, never during render.
  useEffect(() => {
    if (state.status === "success") onSuccess?.();
  }, [state, onSuccess]);

  // The text the person just submitted, echoed back by the action so a rejected
  // form is not blanked. Present only after a failure, so the stored account
  // (or nothing) is the fallback.
  const submitted = state.values;

  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {isEdit && <input type="hidden" name="id" value={account.id} />}

      <Field id={nameId} label="Name" errors={errorsFor("name")}>
        <Input
          id={nameId}
          name="name"
          defaultValue={submitted?.name ?? account?.name ?? ""}
          required
          maxLength={120}
          disabled={pending}
          aria-invalid={errorsFor("name").length > 0 || undefined}
          aria-describedby={errorsFor("name").length > 0 ? `${nameId}-error` : undefined}
        />
      </Field>

      <Field id={institutionId} label="Institution" errors={errorsFor("institution")}>
        <Input
          id={institutionId}
          name="institution"
          defaultValue={submitted?.institution ?? account?.institution ?? ""}
          required
          maxLength={120}
          disabled={pending}
          aria-invalid={errorsFor("institution").length > 0 || undefined}
          aria-describedby={
            errorsFor("institution").length > 0 ? `${institutionId}-error` : undefined
          }
        />
      </Field>

      {isEdit ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Type</span>
          <p className="text-sm text-muted-foreground">
            {ACCOUNT_TYPE_LABEL.get(account.type)} — an account&rsquo;s type cannot be changed.
          </p>
        </div>
      ) : (
        <Field id={typeId} label="Type" errors={errorsFor("type")}>
          <Select
            name="type"
            items={ACCOUNT_TYPE_ITEMS}
            value={type}
            onValueChange={(value) => setType(value as AccountType)}
            disabled={pending}
          >
            <SelectTrigger id={typeId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_TYPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field
        id={openingBalanceId}
        label="Opening balance"
        hint={
          isEdit
            ? "Leave blank to keep the current opening balance. It can only be changed while the account has no transactions."
            : "Signed: enter what you owe on a credit card or loan as a negative amount, e.g. -1284.50."
        }
        errors={errorsFor("openingBalance")}
      >
        <Input
          id={openingBalanceId}
          name="openingBalance"
          inputMode="decimal"
          placeholder={isEdit ? "Unchanged" : "0.00"}
          defaultValue={submitted?.openingBalance ?? ""}
          required={!isEdit}
          disabled={pending}
          aria-invalid={errorsFor("openingBalance").length > 0 || undefined}
          aria-describedby={
            errorsFor("openingBalance").length > 0 ? `${openingBalanceId}-error` : undefined
          }
        />
      </Field>

      {allowsCreditLimit(type) && (
        <Field id={creditLimitId} label="Credit limit" errors={errorsFor("creditLimit")}>
          <Input
            id={creditLimitId}
            name="creditLimit"
            inputMode="decimal"
            placeholder="0.00"
            defaultValue={submitted?.creditLimit ?? centsToInput(account?.creditLimitCents)}
            disabled={pending}
            aria-invalid={errorsFor("creditLimit").length > 0 || undefined}
            aria-describedby={
              errorsFor("creditLimit").length > 0 ? `${creditLimitId}-error` : undefined
            }
          />
        </Field>
      )}

      {allowsInterestRate(type) && (
        <Field
          id={interestRateId}
          label="Interest rate (APR %)"
          hint="A percentage, e.g. 23.99."
          errors={errorsFor("interestRate")}
        >
          <Input
            id={interestRateId}
            name="interestRate"
            inputMode="decimal"
            placeholder="0.00"
            defaultValue={submitted?.interestRate ?? bpsToInput(account?.interestRateBps)}
            disabled={pending}
            aria-invalid={errorsFor("interestRate").length > 0 || undefined}
            aria-describedby={
              errorsFor("interestRate").length > 0 ? `${interestRateId}-error` : undefined
            }
          />
        </Field>
      )}

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add account"}
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
