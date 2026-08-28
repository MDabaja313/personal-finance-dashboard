"use client";

import { useActionState, useCallback, useId, useState } from "react";

import { AccountForm } from "@/components/accounts/account-form";
import type { AccountMutationActions } from "@/components/accounts/types";
import { Button } from "@/components/ui/button";
import type { ActionState, FormAction } from "@/lib/actions/types";
import type { Account } from "@/lib/types";

/**
 * The per-account controls: an edit disclosure and an archive/unarchive
 * submit.
 *
 * Both are ordinary forms posting to Server Actions. There is no optimistic
 * update and no client-side copy of the account: after a successful write the
 * action revalidates `/accounts`, Next.js re-renders the route in the same
 * roundtrip, and this component is re-created from the fresh server data. That
 * is why archiving can be refused by the server and still leave the UI honest —
 * nothing here ever claims a change that did not happen.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

export function AccountCardActions({
  account,
  actions,
}: {
  account: Account;
  actions: AccountMutationActions;
}) {
  const [editing, setEditing] = useState(false);
  const closeEditor = useCallback(() => setEditing(false), []);

  if (editing) {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <AccountForm
          action={actions.update}
          account={account}
          onSuccess={closeEditor}
          onCancel={closeEditor}
        />
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
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
