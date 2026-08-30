import "server-only";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/**
 * Completes a password-recovery email link and always redirects (throws) —
 * nothing after a call to this function runs. This is the only crossing
 * point into `lib/supabase/**` for the recovery confirm route
 * (`app/auth/confirm/route.ts`), which otherwise cannot import it directly
 * (`app/**` is fenced off from `lib/supabase/**` — see
 * `lib/auth/posture.test.ts`).
 *
 * `token_hash`/`type` arrive as plain query-string parameters, not a URL
 * fragment, so this runs entirely server-side with no client-side session
 * parsing — see docs/auth-design.md §4's client-responsibility table.
 * `type` is deliberately narrowed to the literal `"recovery"` rather than
 * Supabase's general `EmailOtpType`: this endpoint has exactly one purpose,
 * and no `next`/redirect-target parameter is accepted from the query string
 * at all, so a stolen or malformed link cannot be turned into an open
 * redirect — the one legitimate destination is hardcoded below.
 */
export async function confirmRecovery(
  tokenHash: string | null,
  type: string | null
): Promise<never> {
  if (tokenHash && type === "recovery") {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    if (!error) redirect("/reset-password");
  }

  // Invalid, expired, or already-used link. No raw Supabase error reaches
  // the visitor — just a flag the forgot-password page reads to show a
  // plain-language explanation and another chance to request a new link.
  redirect("/forgot-password?expired=1");
}
