"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RequestPasswordResetAction, RequestPasswordResetState } from "@/lib/auth/types";

const INITIAL_STATE: RequestPasswordResetState = { status: "idle", message: null };

/**
 * Email only. The action arrives as a prop, not an import, so this stays a
 * plain UI component with no reach into `lib/**` beyond a type — same
 * arrangement as `login-form.tsx`.
 *
 * There is no separate "sent" screen: the form re-renders in place with the
 * same generic message whether or not the address is actually registered,
 * and stays showing the email field so a mistyped address can be corrected
 * and resubmitted without navigating back.
 */
export function ForgotPasswordForm({
  requestAction,
}: {
  requestAction: RequestPasswordResetAction;
}) {
  const [state, formAction, pending] = useActionState(requestAction, INITIAL_STATE);

  const emailId = useId();
  const messageId = useId();

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={emailId} className="text-sm font-medium text-foreground">
          Email
        </label>
        <Input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          disabled={pending}
          aria-describedby={state.message ? messageId : undefined}
        />
      </div>

      {state.message !== null ? (
        <p
          id={messageId}
          role={state.status === "error" ? "alert" : "status"}
          className={state.status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {state.message}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-1 w-full">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
