import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Session-refresh helper for the root proxy.ts (Next.js 16's renamed
 * middleware.ts — see AGENTS.md). Refreshes/propagates the Supabase auth
 * cookies on the request/response pair so a Server Component later in the
 * request has an up-to-date session.
 *
 * This is explicitly not an authorization boundary — see
 * docs/auth-design.md §6. It calls `getClaims()` (the verified-identity
 * path, never `getSession()`, per docs/auth-design.md §5) only to trigger
 * the token refresh; it makes no redirect/authorization decision. Those
 * decisions belong to the app/(app)/layout.tsx guard and the DAL.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { url, publishableKey } = getSupabaseEnv();

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Do not add logic between createServerClient and getClaims() — an
  // intervening call can make session-refresh bugs very hard to trace.
  await supabase.auth.getClaims();

  return response;
}
