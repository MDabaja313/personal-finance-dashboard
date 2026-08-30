"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type {
  RequestPasswordResetState,
  SignInState,
  UpdatePasswordState,
} from "@/lib/auth/types";

/**
 * Auth Server Actions. Cookie writes work here (unlike in a Server
 * Component), so this is where the session is actually established and
 * torn down — `lib/supabase/server.ts` swallows cookie writes when it is
 * called during render.
 *
 * There is no `signUp` here and there never will be: public signup is
 * disabled at the project level and the single owner is provisioned by
 * hand. See docs/auth-design.md §1.
 */

/**
 * The only message the login form ever shows. It does not distinguish
 * "no such account" from "wrong password" — telling those apart turns the
 * form into an account-enumeration oracle — and it never surfaces the
 * AuthError's own text, status, or code.
 */
const INVALID_CREDENTIALS = "Invalid email or password.";

/**
 * Shown regardless of whether the address is actually registered — the
 * single-owner, no-signup posture (docs/auth-design.md §1) makes "no such
 * account" an even more valuable oracle here than it is for `signIn`, so
 * this message never varies and `resetPasswordForEmail`'s own result/error
 * is never inspected.
 */
const RESET_REQUESTED = "If that email is registered, a password reset link has been sent.";
const RESET_REQUEST_FAILED = "Something went wrong. Please try again.";
const PASSWORD_TOO_SHORT = "Password must be at least 8 characters.";
const UPDATE_PASSWORD_FAILED = "Something went wrong. Please try again.";

export async function signIn(
  _previousState: SignInState,
  formData: FormData
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  // Same generic response as a rejected credential — an empty field is
  // not worth a distinguishable reply.
  if (!email || !password) return { error: INVALID_CREDENTIALS };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return { error: INVALID_CREDENTIALS };

  // Drop any RSC payload rendered for the signed-out visitor before
  // navigating, so the app shell re-renders against the new session.
  revalidatePath("/", "layout");

  // Outside any try/catch: redirect() signals by throwing.
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  redirect("/login");
}

/**
 * Requests a password-recovery email. `redirectTo` is derived from the
 * request's own `Origin` header rather than any hardcoded host, so the same
 * code sends a localhost link in local development and a production link
 * when deployed — never the reverse (this was the actual CP8B bug: a
 * hardcoded/misconfigured hosted Site URL put localhost into a production
 * email). The Origin header is reliably present on a same-origin form POST
 * (Next.js itself relies on it to validate Server Action requests), but a
 * missing one fails safely rather than falling back to a guessed host.
 */
export async function requestPasswordReset(
  _previousState: RequestPasswordResetState,
  formData: FormData
): Promise<RequestPasswordResetState> {
  const email = String(formData.get("email") ?? "").trim();

  // Same generic response as a successful request — an empty field tells an
  // attacker nothing either way.
  if (!email) return { status: "success", message: RESET_REQUESTED };

  const origin = (await headers()).get("origin");
  if (!origin) return { status: "error", message: RESET_REQUEST_FAILED };

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm`,
  });
  // The call's own result/error is intentionally never inspected — GoTrue
  // does not reliably distinguish "no such user" here, and branching on it
  // would risk exactly the enumeration oracle the fixed message avoids.

  return { status: "success", message: RESET_REQUESTED };
}

/**
 * Sets a new password for the currently authenticated session — reached
 * either via the recovery link (`app/auth/confirm` → `/reset-password`) or
 * an ordinary active login, both equally valid per Supabase's model.
 * `requireUser()` re-verifies first because a Server Action is an
 * independently reachable endpoint (docs/auth-design.md §10) — it must not
 * assume the caller ever rendered `/reset-password`. Signs the session out
 * afterward so the new password is what has to be used next, and redirects
 * to `/login` either way, per the same rule.
 */
export async function updatePassword(
  _previousState: UpdatePasswordState,
  formData: FormData
): Promise<UpdatePasswordState> {
  await requireUser();

  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: PASSWORD_TOO_SHORT };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: UPDATE_PASSWORD_FAILED };

  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login?reset=success");
}
