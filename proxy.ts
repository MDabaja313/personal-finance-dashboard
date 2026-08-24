import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/**
 * Refreshes the Supabase auth session cookie on every navigation. Not an
 * authorization boundary — see docs/auth-design.md §6. No protected-route
 * redirect logic and no DAL access here; that lands with the
 * app/(app)/layout.tsx guard in a later Phase 5 checkpoint.
 */
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     * - common static asset extensions
     */
    "/((?!_next/static|_next/image|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf)$).*)",
  ],
};
