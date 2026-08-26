/**
 * Parity-suite bootstrap: signs in a real Supabase Auth user with plain
 * `@supabase/supabase-js` — no `next/headers`, no cookie plumbing, since
 * `npm run test:parity` runs outside any Next.js request scope.
 *
 * This is deliberately the *only* thing the parity suite fakes. Every parity
 * test mocks exactly `lib/data/supabase.ts` (the single seam `lib/data/**`
 * uses to reach the database) and injects the client + owner id this module
 * produces, so every mapper, query builder, ordering chain, and error path
 * under test in the production DAL stays real.
 *
 * Fails loudly — never silently skips — when local Supabase isn't running or
 * the local owner can't sign in: a parity run that quietly no-ops would be
 * worse than no parity run at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ENV_PATH = join(ROOT, ".env.local");

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "LOCAL_OWNER_EMAIL",
  "LOCAL_OWNER_PASSWORD",
] as const;

export interface ParityContext {
  client: SupabaseClient;
  ownerId: string;
}

class ParitySetupError extends Error {}

/** Mirrors scripts/verify-auth.ts's .env.local loader. */
function loadEnvFile(path: string): void {
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") process.env[key] = value;
  }
}

let cached: Promise<ParityContext> | undefined;

/**
 * Signs in with the local-only owner credentials and returns an
 * authenticated client plus the verified owner id (from `getClaims()`, never
 * `getSession()` — same authorization rule as `lib/data/supabase.ts`).
 *
 * Cached per test-file module instance so multiple `describe` blocks in one
 * parity test file share a single sign-in.
 */
export function createParityContext(): Promise<ParityContext> {
  if (!cached) cached = signIn();
  return cached;
}

async function signIn(): Promise<ParityContext> {
  if (existsSync(ENV_PATH)) loadEnvFile(ENV_PATH);

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new ParitySetupError(
      `test:parity requires ${missing.join(", ")} to be set (.env.local or the environment). ` +
        "Run `npm run auth:reset-local` first, and ensure a local Supabase stack is running."
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const email = process.env.LOCAL_OWNER_EMAIL!;
  const password = process.env.LOCAL_OWNER_PASSWORD!;

  const client = createClient(url, publishableKey);

  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new ParitySetupError(
      "test:parity could not sign in the local owner. Is the local Supabase stack running " +
        "(`supabase start`) and has `npm run auth:reset-local` been run?",
      { cause: signInError }
    );
  }

  const { data, error: claimsError } = await client.auth.getClaims();
  if (claimsError || !data) {
    throw new ParitySetupError("test:parity signed in but could not verify claims.", {
      cause: claimsError,
    });
  }

  const sub = data.claims.sub;
  if (typeof sub !== "string" || sub === "") {
    throw new ParitySetupError("test:parity received claims with no valid `sub`.");
  }

  return { client, ownerId: sub };
}
