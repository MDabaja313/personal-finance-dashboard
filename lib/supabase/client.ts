import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Browser-side Supabase client, for Client Components. This app is
 * Server-Component-first (see docs/auth-design.md §4), so this seam has no
 * consumer yet as of Phase 5 Checkpoint A1 — it is intentionally kept
 * available for a future Client Component that needs session-aware
 * client-side Supabase interaction (e.g. a client-side auth state
 * listener). Do not invent a consumer merely to use this export.
 */
export function createClient() {
  const { url, publishableKey } = getSupabaseEnv();
  return createBrowserClient(url, publishableKey);
}
