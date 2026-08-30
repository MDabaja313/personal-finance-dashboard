"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UpdatePasswordAction, UpdatePasswordState } from "@/lib/auth/types";

const INITIAL_STATE: UpdatePasswordState = { error: null };

/**
 * New password only — reached exclusively from a verified session (the
 * recovery link or an ordinary active login; see `updatePassword`'s own
 * doc comment). The action arrives as a prop, not an import, matching
 * every other auth form here.
 */
export function ResetPasswordForm({ updateAction }: { updateAction: UpdatePasswordAction }) {
  const [state, formAction, pending] = useActionState(updateAction, INITIAL_STATE);

  const passwordId = useId();
  const errorId = useId();

  const hasError = state.error !== null;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={passwordId} className="text-sm font-medium text-foreground">
          New password
        </label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          disabled={pending}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : undefined}
        />
      </div>

      {hasError ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-1 w-full">
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
