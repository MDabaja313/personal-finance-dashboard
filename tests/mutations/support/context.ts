/**
 * Mutation-suite bootstrap: an authenticated Supabase client and the verified
 * owner id, built from the session `global-setup.ts` established once for the
 * whole run.
 *
 * The same shape as the parity suite's context, and the same single fake:
 * every test mocks exactly `lib/data/supabase.ts` — the one seam `lib/data/**`
 * uses to reach the database — and injects this client and owner id. Everything
 * downstream of that seam is real production code: the mutation DAL, its
 * preflights, the write error mapper, the validation schemas, the Server
 * Actions, and the production read DAL used for read-back. The database is
 * real, RLS is on, and every request carries an ordinary `authenticated` user
 * JWT.
 *
 * What is *not* faked, and would invalidate the suite if it were: no
 * service-role key, no RLS bypass, no stubbed business logic, no fake row
 * builder. The only other mocks any test file installs are `next/cache` and
 * `next/navigation`, which exist because a Server Action calls
 * `revalidatePath()`/`redirect()` and there is no Next.js request context in a
 * test process — see `mutation-harness.ts`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inject } from "vitest";

export interface MutationContext {
  client: SupabaseClient;
  ownerId: string;
}

class MutationSetupError extends Error {}

let cached: Promise<MutationContext> | undefined;

/** The authenticated client + verified owner id for this test file. */
export function createMutationContext(): Promise<MutationContext> {
  if (!cached) cached = build();
  return cached;
}

async function build(): Promise<MutationContext> {
  const auth = inject("mutationAuth");

  const client = createClient(auth.url, auth.publishableKey, {
    // No session to persist and nothing to refresh: the run is far shorter than
    // the token's lifetime, and an autorefresh timer would keep the worker's
    // event loop alive after the last test.
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  });

  await verify(client, auth.ownerId);

  return { client, ownerId: auth.ownerId };
}

/**
 * Proves the client really is acting as the owner before any test runs.
 *
 * Without this, a client that silently fell back to the publishable key would
 * still "work": RLS would filter reads to zero rows and refuse writes, and
 * every failure would read as a broken mutation rather than as an auth
 * misconfiguration. That distinction matters more here than in the parity
 * suite, because a *write* test that fails for the wrong reason looks exactly
 * like the security property it is supposed to be proving.
 */
async function verify(client: SupabaseClient, ownerId: string): Promise<void> {
  const { data, error } = await client.from("profiles").select("id").eq("id", ownerId);

  if (error) {
    throw new MutationSetupError(
      "test:mutations could not read the owner profile with the injected session. Is the local " +
        "Supabase stack still running?",
      { cause: error }
    );
  }
  if (data.length !== 1) {
    throw new MutationSetupError(
      "test:mutations is not authenticated as the owner — the owner profile was not visible. " +
        "The injected access token is not being applied to PostgREST requests."
    );
  }
}
