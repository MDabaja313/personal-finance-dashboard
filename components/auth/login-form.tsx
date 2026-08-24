"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SignInAction, SignInState } from "@/lib/auth/types";

const INITIAL_STATE: SignInState = { error: null };

/**
 * Email + password, and nothing else. No signup link, no OAuth buttons, no
 * magic-link fallback, no password reset — the single owner is provisioned
 * by hand and public signup is disabled at the project level
 * (docs/auth-design.md §1).
 *
 * The action arrives as a prop rather than an import so this stays a plain
 * UI component with no reach into `lib/**` beyond a type.
 */
export function LoginForm({ signInAction }: { signInAction: SignInAction }) {
  const [state, formAction, pending] = useActionState(signInAction, INITIAL_STATE);

  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const hasError = state.error !== null;

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
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={passwordId} className="text-sm font-medium text-foreground">
          Password
        </label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : undefined}
        />
      </div>

      {/* Rendered only on failure, but announced when it appears. */}
      {hasError ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-1 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
