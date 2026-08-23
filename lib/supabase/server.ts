import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Server-side Supabase client for Server Components, Server Actions, and
 * Route Handlers. Reads/writes the session via Next.js 16's async
 * `cookies()`. Uses the publishable key only — see docs/auth-design.md §4.
 *
 * Callers must use `supabase.auth.getClaims()` (or `getUser()` when an
 * up-to-date Auth record is specifically needed) for authorization —
 * `getSession()` is never used to authorize a request. See
 * docs/auth-design.md §5.
 *
 * A fresh client is created per call (the Supabase-recommended pattern for
 * Server Components) rather than reused across requests.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseEnv();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component, which cannot write cookies.
          // Safe to ignore as long as proxy.ts is refreshing the session
          // on navigation (see lib/supabase/proxy.ts).
        }
      },
    },
  });
}
