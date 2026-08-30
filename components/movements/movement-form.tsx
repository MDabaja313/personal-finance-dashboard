"use client";

import { useActionState, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import type { MovementAccountOption, MovementEditRow } from "@/components/movements/types";
import { INITIAL_MOVEMENT_ACTION_STATE } from "@/components/movements/types";
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
import { MOVEMENT_KINDS, type MovementKind } from "@/lib/types/enums";
import { optionItems, selectItems } from "@/lib/ui/select-items";

/**
 * The transfer / credit-card-payment create and edit form.
 *
 * A plain `<form>` driven by `useActionState`, with no form library — the same
 * arrangement as `TransactionForm`, and every rule deciding whether a
 * submission is acceptable still lives on the server
 * (`lib/validation/movements.ts`, then the mutation DAL's preflights, then
 * `public.create_movement`, then `assert_transaction_refs()` and
 * `validate_movement()`). This component's jobs are to render the controls,
 * keep a person from being offered a choice the server would refuse, disable
 * submit while a request is in flight, and show whatever the returned
 * `ActionState` says.
 *
 * The action arrives as a prop rather than an import — `components/**` is
 * fenced away from value imports of `lib/actions/**`, and the route is the
 * seam.
 *
 * ## Why this is not the transaction form with two extra fields
 *
 * There is no merchant field: a leg's label is composed by the database from
 * the movement's kind and the other account's name, so the pair's two labels
 * are consistent by construction. There is no category field: moving money
 * between owned accounts is not consumption, and the database refuses one three
 * different ways. And there is no type-and-sign relationship — the *roles* of
 * the two accounts decide the signs, so the amount is a plain magnitude with
 * nothing to contradict.
 *
 * ## The destination narrows itself for a card payment
 *
 * A credit-card payment must be paid *into* a credit account: that is the
 * convention `lib/types/index.ts` states, and both the mutation preflight and
 * `public.create_movement` enforce it. So when the kind is
 * `credit_card_payment` the destination picker offers credit accounts only, and
 * switching to it clears a destination that can no longer serve — in the event
 * handler that caused it, rather than in an effect reacting to the result,
 * which would re-render twice and briefly show a picker displaying a value that
 * is not in its own option list.
 *
 * The source picker is deliberately *not* narrowed. Paying a card from cash,
 * from savings, or from another card are all things a person may legitimately
 * record, and the repository states no rule about a source's type.
 */

const KIND_LABELS: Record<MovementKind, string> = {
  transfer: "Transfer",
  credit_card_payment: "Credit card payment",
};

/** Per-kind wording for the two account pickers — "From"/"To" is too vague for a payment. */
const ACCOUNT_LABELS: Record<MovementKind, { from: string; to: string; toHint: string }> = {
  transfer: {
    from: "From account",
    to: "To account",
    toHint: "Money leaves the first account and arrives in this one.",
  },
  credit_card_payment: {
    from: "Paid from",
    to: "Card being paid",
    toHint: "A payment reduces the funding account and moves the card's balance toward zero.",
  },
};

/**
 * Cents → the decimal string a money input should start with.
 *
 * Integer division and a padded remainder, never `cents / 100` — the same
 * reason `lib/validation/money.ts` refuses to build a float on the way in.
 * `amountCents` is already a positive magnitude, so there is no sign to drop.
 */
function magnitudeToInput(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

interface MovementFormProps {
  action: FormAction;
  accounts: readonly MovementAccountOption[];
  /** The owner's calendar day — the date field's default and its ceiling. */
  today: CalendarDate;
  /** Absent = create. Present = edit that movement. */
  movement?: MovementEditRow;
  /** Called once, after a submission the server reported as successful. */
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function MovementForm({
  action,
  accounts,
  today,
  movement,
  onSuccess,
  onCancel,
}: MovementFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_MOVEMENT_ACTION_STATE);

  const isEdit = movement !== undefined;

  const [kind, setKind] = useState<MovementKind>(movement?.kind ?? "transfer");
  const [fromAccountId, setFromAccountId] = useState<string>(
    movement?.fromAccountId ?? accounts[0]?.id ?? ""
  );
  const [toAccountId, setToAccountId] = useState<string>(movement?.toAccountId ?? "");

  /**
   * The three ids this submission writes under.
   *
   * On **edit** they are the movement's own: a replacement keeps the movement's
   * id (so editing a transfer never changes what it is) and reuses both leg
   * ids (so a leg keeps its row identity rather than being reincarnated).
   *
   * On **create** they are minted once by a lazy `useState` initializer and
   * never change while the form is on screen — precisely the lifetime the
   * idempotency key needs:
   *
   * - Every retry of the same visible form — a double click, a resubmit after a
   *   validation failure, a resubmit after a response was lost in flight —
   *   posts the *same* three keys, so the second attempt collides with the
   *   first on the movements primary key instead of writing a second transfer.
   *   The lost-response case is the one that matters most: the movement was
   *   written, the person never saw the confirmation, and pressing the button
   *   again is the only sensible thing they can do.
   * - A *new* logical movement gets new keys, because the panel unmounts when
   *   it closes and `AddMovement` remounts the form for the next one.
   *
   * No `useEffect` and no post-success mutation: regenerating in place would
   * mean a window in which the form is on screen with keys that no longer match
   * the submission the person is watching.
   *
   * `crypto.randomUUID()` during render is safe here because this form is only
   * ever mounted inside an open sheet — a client-side portal that does not
   * server-render — so there is no server HTML for the hidden inputs to
   * disagree with.
   */
  const [keys] = useState(() =>
    movement
      ? {
          id: movement.id,
          sourceLegId: movement.sourceLegId,
          destinationLegId: movement.destinationLegId,
        }
      : {
          id: crypto.randomUUID(),
          sourceLegId: crypto.randomUUID(),
          destinationLegId: crypto.randomUUID(),
        }
  );

  const kindId = useId();
  const fromId = useId();
  const toId = useId();
  const amountId = useId();
  const dateId = useId();
  const formErrorId = useId();

  // Closing the panel is the parent's business, and it is a state update in
  // another component — so it happens after commit, never during render.
  useEffect(() => {
    if (state.status === "success") onSuccess?.();
  }, [state, onSuccess]);

  /** The accounts the destination picker may offer for the current kind. */
  const destinationOptions = useMemo(
    () =>
      kind === "credit_card_payment"
        ? accounts.filter((account) => account.type === "credit")
        : accounts,
    [accounts, kind]
  );

  function changeKind(next: MovementKind): void {
    setKind(next);
    if (toAccountId === "") return;
    const stillValid =
      next !== "credit_card_payment" ||
      accounts.some((account) => account.id === toAccountId && account.type === "credit");
    if (!stillValid) setToAccountId("");
  }

  const submitted = state.values;
  const errorsFor = (field: string): readonly string[] => state.fieldErrors[field] ?? [];

  const labels = ACCOUNT_LABELS[kind];

  // Base UI resolves a Select's trigger text from the Root's `items` map and
  // falls back to `String(value)` without one — a raw UUID for both account
  // pickers, and the wire label for the kind. The submitted values are
  // unchanged; see `lib/ui/select-items.ts`.
  const kindLabels = useMemo(
    () => selectItems(MOVEMENT_KINDS.map((option) => ({ value: option, label: KIND_LABELS[option] }))),
    []
  );
  const sourceLabels = useMemo(() => optionItems(accounts), [accounts]);
  const destinationLabels = useMemo(() => optionItems(destinationOptions), [destinationOptions]);

  // A movement needs two different accounts to exist at all, and a card payment
  // needs a credit account to aim at. Both are "there is nothing to submit",
  // not "the submission is wrong", so the button is disabled rather than the
  // form rejected after a roundtrip.
  const hasSomewhereToGo = accounts.length >= 2 && destinationOptions.length > 0;
  const submitDisabled = pending || !hasSomewhereToGo;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {/* Minted or carried forward once per mounted form — see `keys` above. */}
      <input type="hidden" name="id" value={keys.id} />
      <input type="hidden" name="sourceLegId" value={keys.sourceLegId} />
      <input type="hidden" name="destinationLegId" value={keys.destinationLegId} />

      {/* The destination cannot carry `name` on its Select: it starts unset, and
          an empty item value is not something a Select can hold, so its hidden
          input is written here instead. The other two controls emit their own. */}
      <input type="hidden" name="toAccountId" value={toAccountId} />

      <Field id={kindId} label="Type" errors={errorsFor("kind")}>
        <Select
          name="kind"
          items={kindLabels}
          value={kind}
          onValueChange={(value) => changeKind(value as MovementKind)}
          disabled={pending}
        >
          <SelectTrigger id={kindId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MOVEMENT_KINDS.map((option) => (
              <SelectItem key={option} value={option}>
                {KIND_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id={fromId} label={labels.from} errors={errorsFor("fromAccountId")}>
        {accounts.length < 2 ? (
          <p className="text-sm text-muted-foreground">
            Add a second account before moving money between them.
          </p>
        ) : (
          <Select
            name="fromAccountId"
            items={sourceLabels}
            value={fromAccountId}
            onValueChange={(value) => setFromAccountId(String(value))}
            disabled={pending}
          >
            <SelectTrigger id={fromId} className="w-full">
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

      <Field id={toId} label={labels.to} hint={labels.toHint} errors={errorsFor("toAccountId")}>
        {destinationOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {kind === "credit_card_payment"
              ? "Add a credit account before recording a card payment."
              : "Add a second account before moving money between them."}
          </p>
        ) : (
          <Select
            items={destinationLabels}
            value={toAccountId}
            onValueChange={(value) => setToAccountId(String(value))}
            disabled={pending}
          >
            <SelectTrigger id={toId} className="w-full">
              <SelectValue placeholder="Select an account" />
            </SelectTrigger>
            <SelectContent>
              {destinationOptions.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Field
        id={amountId}
        label="Amount"
        hint="How much moves. The two accounts above decide the direction — there is no minus sign to type."
        errors={errorsFor("amount")}
      >
        <Input
          id={amountId}
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          defaultValue={
            submitted?.amount ?? (movement ? magnitudeToInput(movement.amountCents) : "")
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
        hint="A movement records money that has already moved, so it cannot be dated ahead of today."
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
          defaultValue={submitted?.date ?? movement?.date ?? today}
          required
          disabled={pending}
          aria-invalid={errorsFor("date").length > 0 || undefined}
          aria-describedby={errorsFor("date").length > 0 ? `${dateId}-error` : undefined}
        />
      </Field>

      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button type="submit" disabled={submitDisabled}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Record it"}
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
