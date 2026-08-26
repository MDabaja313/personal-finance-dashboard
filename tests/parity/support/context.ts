/**
 * Parity-suite bootstrap: builds an authenticated Supabase client for one test
 * file from the session material `global-setup.ts` established **once** for
 * the whole run.
 *
 * This module used to call `signInWithPassword` itself, once per test file
 * (Vitest isolates module state per file, so the cache below never spanned
 * more than one). It now performs no authentication round-trip at all: the
 * single sign-in happens in the Vitest main process, and each file receives
 * the resulting access token through `inject()`.
 *
 * The client is constructed with that token as an explicit `Authorization`
 * header rather than a restored session, which is what makes this free: no
 * token exchange, no refresh, no `/auth/v1/user` call. Every PostgREST request
 * still carries an ordinary `authenticated` user JWT, so RLS applies exactly
 * as in production — and `verify()` below proves that per file rather than
 * assuming it, so a mis-wired header fails loudly instead of quietly reading
 * as `anon` (which would surface as empty results, not an error).
 *
 * This is deliberately still the *only* thing the parity suite fakes. Every
 * parity test mocks exactly `lib/data/supabase.ts` — the single seam
 * `lib/data/**` uses to reach the database — and injects the client + owner id
 * this module produces, so every mapper, query builder, ordering chain, and
 * error path under test in the production DAL stays real.
 *
 * Fails loudly — never silently skips — when anything is wrong: a parity run
 * that quietly no-ops would be worse than no parity run at all.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inject } from "vitest";

export interface ParityContext {
  client: SupabaseClient;
  ownerId: string;
  /** `profiles.timezone` as stored, read once by `global-setup.ts`. */
  ownerTimezone: string;
}

class ParitySetupError extends Error {}

let cached: Promise<ParityContext> | undefined;

/**
 * The authenticated client + verified owner id for this test file.
 *
 * Cached per test-file module instance so multiple `describe` blocks in one
 * file share a single client and a single verification read.
 */
export function createParityContext(): Promise<ParityContext> {
  if (!cached) cached = build();
  return cached;
}

async function build(): Promise<ParityContext> {
  const auth = inject("parityAuth");

  const client = createClient(auth.url, auth.publishableKey, {
    // No session to persist and nothing to refresh: the run is far shorter
    // than the token's lifetime, and an autorefresh timer would keep the
    // worker's event loop alive after the last test.
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  });

  await verify(client, auth.ownerId);

  return { client, ownerId: auth.ownerId, ownerTimezone: auth.ownerTimezone };
}

/**
 * Proves the client really is acting as the owner before any test runs.
 *
 * Without this, a client that silently fell back to the publishable key would
 * still "work" — RLS would just filter everything to zero rows, and the parity
 * failures would read as data problems rather than as an auth misconfiguration.
 */
async function verify(client: SupabaseClient, ownerId: string): Promise<void> {
  const { data, error } = await client.from("profiles").select("id").eq("id", ownerId);

  if (error) {
    throw new ParitySetupError(
      "test:parity could not read the owner profile with the injected session. Is the local " +
        "Supabase stack still running, and has `npm run auth:reset-local` been run?",
      { cause: error }
    );
  }
  if (data.length !== 1) {
    throw new ParitySetupError(
      "test:parity is not authenticated as the owner — the owner profile was not visible. " +
        "The injected access token is not being applied to PostgREST requests."
    );
  }
}
