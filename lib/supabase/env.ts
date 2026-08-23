/**
 * The only module permitted to read Supabase environment variables — see
 * CLAUDE.md ("lib/supabase/** — the only layer that reads Supabase env vars
 * / constructs clients") and docs/auth-design.md §12. Consumed by both the
 * browser client (client.ts) and the server-side clients (server.ts,
 * proxy.ts), so this file must stay import-safe in a browser bundle: no
 * `server-only`, and only the two `NEXT_PUBLIC_*` values below — never a
 * secret, service-role, or database-password value.
 */

export interface SupabaseEnv {
  url: string;
  publishableKey: string;
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL. Set it in .env.local (see .env.example)."
    );
  }
  if (!publishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Set it in .env.local (see .env.example)."
    );
  }

  return { url, publishableKey };
}
