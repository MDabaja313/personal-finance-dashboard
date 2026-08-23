"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { SignInState } from "@/lib/auth/types";

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
