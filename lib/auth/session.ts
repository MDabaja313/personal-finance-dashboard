import "server-only";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { VerifiedUser } from "@/lib/auth/types";

/**
 * The application-facing server auth facade. `app/**` and `components/**`
 * talk to this module, never to `lib/supabase/**` directly — the ESLint
 * boundary in eslint.config.mjs enforces that, and this file is the
 * sanctioned way across it.
 *
 * Every check here goes through `getClaims()`, which verifies the access
 * token's signature locally. `getSession()` is never used to authorize
 * anything anywhere in this application: cookie-backed session data is not
 * a verified identity and can be stale or forged. See
 * docs/auth-design.md §5. (`getUser()` remains the right call in the
 * narrow case where a live Auth-server record is genuinely needed — none
 * exists yet.)
 */

/**
 * The verified identity behind the current request, or `null` when there
 * isn't one. Returns rather than redirects, so a route can branch on it —
 * `/login` uses it to bounce an already-signed-in visitor to the app.
 */
export async function getVerifiedClaims(): Promise<VerifiedUser | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data) return null;

  const { sub, email } = data.claims;
  if (typeof sub !== "string" || sub === "") return null;

  return { id: sub, email: typeof email === "string" ? email : null };
}

/**
 * The verified identity, or a redirect to `/login`.
 *
 * This is the shape the `app/(app)/layout.tsx` guard consumes — that guard
 * is Checkpoint A3 and is not wired up yet. It is equally the shape a
 * Server Action uses to re-establish identity: a Server Action is an
 * independently reachable endpoint and cannot assume the caller ever
 * rendered a guarded page (docs/auth-design.md §8, §10).
 */
export async function requireUser(): Promise<VerifiedUser> {
  const user = await getVerifiedClaims();
  if (!user) redirect("/login");
  return user;
}
