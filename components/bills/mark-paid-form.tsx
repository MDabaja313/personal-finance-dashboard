"use client";

import { useActionState, useEffect, useId, useMemo, useState } from "react";

import type { GeneratedPaymentPreview, TransactionOption } from "@/components/bills/types";
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
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { CalendarDate, Cents } from "@/lib/types";
import { selectItems } from "@/lib/ui/select-items";

/**
 * The "Mark paid" form for one scheduled occurrence.
 *
 * Two fields, and what happens to the ledger depends on the second one.
 *
 * **The paid date defaults to the owner's own today**, resolved on the server
 * from `profiles.timezone` and passed in — never `new Date()` in the browser,
 * which would be the *viewer's* timezone and could sit a day either side of
 * the ceiling `guard_bill_occurrence_transition()` actually enforces. The
 * input's `max` is the same value, so the browser refuses a future date before
 * the server has to. It is also the date a generated expense takes.
 *
 * ## What this form tells a person, before they press the button
 *
 * Phase 8 CP1 made marking a bill paid capable of writing a real expense, and a
 * control that may or may not create a ledger row has to say which. The page
 * resolves that on the server — from the bill's account and category, using the
 * identical rules `public.settle_bill_occurrence` applies — and passes it in as
 * `generatedPayment`. The three cases the notice covers are exactly the three
 * the database can produce:
 *
 * - a transaction is picked → it is linked, nothing is created, and that
 *   transaction is not altered in any way;
 * - nothing is picked and the bill has a usable account → one expense is
 *   created for the occurrence's own amount;
 * - nothing is picked and the bill has no usable account → the occurrence is
 *   marked paid and no ledger row exists.
 *
 * The notice re-renders as the picker changes, so it always describes the
 * submission that is actually staged.
 *
 * ## The submission key
 *
 * `generatedTransactionId` is minted once per mounted form and is the `id` the
 * generated expense will take, so a retry collides with itself on the primary
 * key rather than writing a second payment. It is posted on every submission,
 * including the link-an-existing-transaction one where it goes unused: whether
 * a row gets generated is the server's decision, and the browser must not have
 * to predict it in order to supply a key.
 *
 * It is the *first* of three idempotency layers rather than the main one — the
 * settle RPC short-circuits an already-paid occurrence before it inserts
 * anything, which is what actually catches a double click or a lost response.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

/** The sentinel for "no linked transaction" — an empty option value is not selectable. */
const NONE = "none";

export function MarkPaidForm({
  action,
  occurrenceId,
  dueDate,
  amountCents,
  today,
  transactions,
  generatedPayment,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  occurrenceId: string;
  dueDate: CalendarDate;
  amountCents: Cents;
  /** The owner's calendar day, from `profiles.timezone` — never the browser's. */
  today: CalendarDate;
  transactions: readonly TransactionOption[];
  /**
   * What the server will create if no transaction is linked, or `undefined`
   * when the bill names no usable account and marking paid stays status-only.
   */
  generatedPayment?: GeneratedPaymentPreview;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [transactionId, setTransactionId] = useState<string>(NONE);

  // One key per mounted form. `crypto.randomUUID()` during render is safe
  // because this form only ever mounts inside an already-open disclosure, so
  // there is no server HTML for the hidden input to disagree with.
  const [generatedTransactionId] = useState(() => crypto.randomUUID());

  const paidOnId = useId();
  const transactionFieldId = useId();
  const formErrorId = useId();

  // Base UI's `<Select.Value>` reads the Root's `items` map and falls back to
  // `String(value)` without one — which here is a raw transaction UUID. The
  // submitted value is unchanged. See `lib/ui/select-items.ts`.
  const transactionLabels = useMemo(
    () =>
      selectItems([
        { value: NONE, label: "No linked transaction" },
        ...transactions.map((transaction) => ({
          value: transaction.id,
          label: transaction.label,
        })),
      ]),
    [transactions]
  );

  useEffect(() => {
    if (state.status === "success") onSuccess();
  }, [state, onSuccess]);

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  const willLink = transactionId !== NONE;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={occurrenceId} />
      <input type="hidden" name="generatedTransactionId" value={generatedTransactionId} />
      <input
        type="hidden"
        name="transactionId"
        value={transactionId === NONE ? "" : transactionId}
      />

      <p className="text-sm text-foreground">
        {formatCents(amountCents)} due {formatCalendarDate(dueDate)}
      </p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={paidOnId} className="text-sm font-medium text-foreground">
          Paid on
        </label>
        <Input
          id={paidOnId}
          name="paidOn"
          type="date"
          max={today}
          defaultValue={submitted?.paidOn ?? today}
          required
          disabled={pending}
          aria-invalid={errorsFor("paidOn").length > 0 || undefined}
          aria-describedby={errorsFor("paidOn").length > 0 ? `${paidOnId}-error` : undefined}
        />
        {errorsFor("paidOn").length > 0 && (
          <p id={`${paidOnId}-error`} role="alert" className="text-xs text-destructive">
            {errorsFor("paidOn").join(" ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={transactionFieldId} className="text-sm font-medium text-foreground">
          Link a transaction (optional)
        </label>
        <Select
          items={transactionLabels}
          value={transactionId}
          onValueChange={(value) => setTransactionId(String(value))}
          disabled={pending}
        >
          <SelectTrigger id={transactionFieldId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No linked transaction</SelectItem>
            {transactions.map((transaction) => (
              <SelectItem key={transaction.id} value={transaction.id}>
                {transaction.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errorsFor("transactionId").length > 0 && (
          <p role="alert" className="text-xs text-destructive">
            {errorsFor("transactionId").join(" ")}
          </p>
        )}
      </div>

      <LedgerEffectNotice
        amountCents={amountCents}
        willLink={willLink}
        generatedPayment={generatedPayment}
      />

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Mark paid"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Exactly what this submission will do to the ledger, in one sentence.
 *
 * Worth its own component because it is the part a person can be surprised by,
 * and because the three branches must stay in step with the three the settle
 * function can produce. The amount named is the *occurrence's* own amount — the
 * figure the generated expense will carry — never the parent bill's current
 * one, which may have been repriced since this instance was generated.
 */
function LedgerEffectNotice({
  amountCents,
  willLink,
  generatedPayment,
}: {
  amountCents: Cents;
  willLink: boolean;
  generatedPayment?: GeneratedPaymentPreview;
}) {
  if (willLink) {
    return (
      <p className="text-xs text-muted-foreground">
        The transaction you picked will be linked to this bill. Nothing new is recorded, and that
        transaction is not altered in any way — its amount, category, account and date all stay
        exactly as they are. Unmarking this bill later clears the link and leaves it untouched.
      </p>
    );
  }

  if (generatedPayment === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        This bill has no account set, so marking it paid records only that the obligation was met —
        no transaction is created and no account balance changes. Add an account to the bill if you
        want the payment recorded in your ledger.
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      This will record a {formatCents(amountCents)} expense in {generatedPayment.accountName}
      {generatedPayment.categoryName === undefined
        ? ", uncategorized"
        : ` under ${generatedPayment.categoryName}`}
      , dated the paid date above. It counts toward this month&rsquo;s spending and that
      category&rsquo;s budget. Unmarking this bill later removes it again.
    </p>
  );
}
