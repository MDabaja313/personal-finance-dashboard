import "server-only";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/**
 * Completes a password-recovery email link and always redirects (throws) —
 * nothing after a call to this function runs. This is the only crossing
 * point into `lib/supabase/**` for the recovery callback route
 * (`app/auth/callback/route.ts`), which otherwise cannot import it directly
 * (`app/**` is fenced off from `lib/supabase/**` — see
 * `lib/auth/posture.test.ts`).
 *
 * ## Why `exchangeCodeForSession`, not `verifyOtp`
 *
 * `@supabase/ssr` v0.12.4 hardcodes `flowType: "pkce"` on *both* the browser
 * and server clients (`node_modules/@supabase/ssr/dist/module/create*.js` —
 * not an app-level choice, and not overridable via options). A `code` this
 * app ever generates therefore always comes from `resetPasswordForEmail`
 * (`lib/auth/actions.ts`), called from a Server Action using the server
 * client — which writes the matching PKCE code-verifier as a cookie on that
 * response (`@supabase/ssr`'s storage adapter has first-class support for
 * this — `isPkceVerifierSlotKey`/`isPkceFlowIndexKey` in
 * `node_modules/@supabase/ssr/dist/module/cookies.js`). Supabase's *default*
 * password-reset email template already links through GoTrue's own
 * `/verify` endpoint to `redirectTo` with that code attached as a plain
 * `?code=` query parameter — no custom email-template edit required, which
 * is exactly the constraint this project runs under (Free-tier hosted
 * project, no custom SMTP, template editing unavailable). The whole exchange
 * therefore happens entirely server-side: no URL fragment, no client-side
 * session parsing, and `/reset-password` can keep gating on `requireUser()`
 * exactly as every other protected page does — the session already exists
 * by the time that page renders.
 *
 * `exchangeCodeForSession` returns `data.redirectType`, sourced from the
 * stored verifier itself (`GoTrueClient.js`'s `_exchangeCodeForSession`) —
 * `"recovery"` for exactly this flow. Checked as defense-in-depth: this app
 * has no other PKCE-code-generating flow (no OAuth, no magic link, no
 * signup), so it should never be anything else, but this endpoint accepts
 * nothing less than an explicit recovery code. No `next`/redirect-target
 * parameter is accepted from the query string — the one legitimate
 * destination is hardcoded below, so a captured or replayed link can't be
 * turned into an open redirect.
 */
export async function confirmRecovery(code: string | null): Promise<never> {
  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    // `data.redirectType` is set at runtime (GoTrueClient.js's
    // `_exchangeCodeForSession`) but is absent from @supabase/auth-js
    // 2.112.3's published `AuthTokenResponse` type — verified directly
    // against the installed .js source, not merely assumed, so this is a
    // narrow, documented cast rather than a blind `any`.
    const redirectType = (data as unknown as { redirectType?: string | null }).redirectType;
    if (!error && redirectType === "recovery") redirect("/reset-password");
  }

  // Missing, invalid, expired, or already-used code. No raw Supabase error
  // reaches the visitor — just a flag the forgot-password page reads to show
  // a plain-language explanation and another chance to request a new link.
  redirect("/forgot-password?expired=1");
}
