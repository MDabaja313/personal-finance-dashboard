"use client";

import { useActionState, useCallback, useId, useState } from "react";

import { AccountForm } from "@/components/accounts/account-form";
import { ReconcileForm } from "@/components/accounts/reconcile-form";
import type { AccountMutationActions } from "@/components/accounts/types";
import { Button } from "@/components/ui/button";
import type { ActionState, FormAction } from "@/lib/actions/types";
import type { Account, CalendarDate } from "@/lib/types";

/**
 * The per-account controls: an edit disclosure, a reconcile disclosure, and an
 * archive/unarchive submit.
 *
 * All three are ordinary forms posting to Server Actions. There is no
 * optimistic update and no client-side copy of the account: after a successful
 * write the action revalidates `/accounts`, Next.js re-renders the route in the
 * same roundtrip, and this component is re-created from the fresh server data.
 * That is why archiving can be refused by the server and still leave the UI
 * honest — nothing here ever claims a change that did not happen.
 *
 * ## Only one disclosure is open at a time
 *
 * Edit and Reconcile are mutually exclusive, and not merely for layout: they
 * ask contradictory questions about the same number. The edit form's opening
 * balance *restates history* (and is refused outright once the account has any
 * transaction), while reconciling *adds a dated correction* and leaves history
 * alone. Showing both at once would invite someone to answer both.
 *
 * ## An archived account cannot be reconciled
 *
 * It is offered as a sentence rather than as a disabled button, because a
 * disabled control invites the question "why?" without answering it. The rule
 * itself is not cosmetic: `assert_transaction_refs()` refuses any row against
 * an archived account, and `public.reconcile_account` refuses one before it
 * gets that far — so the control would always fail. Archiving also requires a
 * derived balance of exactly zero, which means an archived account has nothing
 * left to reconcile until it is brought back.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

type OpenPanel = "none" | "edit" | "reconcile";

export function AccountCardActions({
  account,
  actions,
  today,
}: {
  account: Account;
  actions: AccountMutationActions;
  /** The owner's calendar day, resolved once on the server for the whole page. */
  today: CalendarDate;
}) {
  const [panel, setPanel] = useState<OpenPanel>("none");
  const close = useCallback(() => setPanel("none"), []);

  if (panel === "edit") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <AccountForm
          action={actions.update}
          account={account}
          onSuccess={close}
          onCancel={close}
        />
      </div>
    );
  }

  if (panel === "reconcile") {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <ReconcileForm
          action={actions.reconcile}
          account={account}
          today={today}
          onSuccess={close}
          onCancel={close}
        />
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button type="button" variant="outline" size="sm" onClick={() => setPanel("edit")}>
        Edit
        <span className="sr-only"> {account.name}</span>
      </Button>

      {account.isArchived ? (
        <span className="text-xs text-muted-foreground">
          Archived — unarchive first to reconcile.
        </span>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setPanel("reconcile")}>
          Reconcile balance
          <span className="sr-only"> for {account.name}</span>
        </Button>
      )}

      <ArchiveToggle
        action={actions.setArchived}
        accountId={account.id}
        isArchived={account.isArchived}
      />
    </div>
  );
}

/**
 * One button in one form.
 *
 * `archived` is the *target* state, carried as a hidden field rather than
 * inferred server-side from the current row: inferring it would turn a
 * double-submit into a toggle back, and the person would have no way to tell
 * which of the two presses won.
 */
function ArchiveToggle({
  action,
  accountId,
  isArchived,
}: {
  action: FormAction;
  accountId: string;
  isArchived: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const errorId = useId();

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="id" value={accountId} />
        <input type="hidden" name="archived" value={isArchived ? "false" : "true"} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Saving…" : isArchived ? "Unarchive" : "Archive"}
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
