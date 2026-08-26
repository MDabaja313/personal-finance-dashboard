/**
 * Vitest `globalSetup` for the parity suite: **exactly one** password sign-in
 * per `npm run test:parity` run.
 *
 * Before Checkpoint 4 each parity test *file* signed in separately (Vitest
 * isolates modules per file, so the module-level cache in `context.ts` only
 * ever deduplicated within one file). That was eight `signInWithPassword`
 * round-trips per run, and it is what made the run vulnerable to the transient
 * `PGRST301` observed immediately after `npm run auth:reset-local`, while the
 * freshly provisioned owner was still settling.
 *
 * This runs once, in the Vitest main process, and hands the resulting **access
 * token** to the workers through `project.provide()`. Each test file then
 * builds its own Supabase client carrying that bearer token — see
 * `context.ts`. Isolation is not weakened: every file still gets a distinct
 * client instance and a distinct module graph; only the credential exchange is
 * shared, and it is the same single owner identity every file was signing in
 * as anyway.
 *
 * Security properties this keeps:
 *
 *  - No credential is ever provided to the workers or printed — the password
 *    is read here and never leaves this process, and the token is not logged.
 *  - No service-role or admin key is involved anywhere. The token is an
 *    ordinary `authenticated` user JWT obtained through the publishable key,
 *    so RLS applies to every parity query exactly as it does in production.
 *  - Failure is hard. A parity run that could not authenticate throws here and
 *    the whole run fails; it never degrades into skipped or vacuous tests.
 *
 * No production code exists for this harness's benefit: `lib/data/**` is
 * untouched by any of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";
import type { TestProject } from "vitest/node";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ENV_PATH = join(ROOT, ".env.local");

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "LOCAL_OWNER_EMAIL",
  "LOCAL_OWNER_PASSWORD",
] as const;

/**
 * What the workers receive. Deliberately **no password** — a worker can act as
 * the owner for the life of this run, and cannot re-authenticate as them.
 */
export interface ParityAuth {
  url: string;
  publishableKey: string;
  accessToken: string;
  ownerId: string;
  /** `profiles.timezone` as the database actually holds it, for the clock parity check. */
  ownerTimezone: string;
}

declare module "vitest" {
  interface ProvidedContext {
    parityAuth: ParityAuth;
  }
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

export default async function setup(project: TestProject): Promise<void> {
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

  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: process.env.LOCAL_OWNER_EMAIL!,
    password: process.env.LOCAL_OWNER_PASSWORD!,
  });
  if (signInError || !signInData.session) {
    throw new ParitySetupError(
      "test:parity could not sign in the local owner. Is the local Supabase stack running " +
        "(`supabase start`) and has `npm run auth:reset-local` been run?",
      { cause: signInError }
    );
  }

  // The owner id comes from verified claims, never from `getSession()` — the
  // same authorization rule `lib/data/supabase.ts` follows.
  const { data: claimsData, error: claimsError } = await client.auth.getClaims();
  if (claimsError || !claimsData) {
    throw new ParitySetupError("test:parity signed in but could not verify claims.", {
      cause: claimsError,
    });
  }
  const ownerId = claimsData.claims.sub;
  if (typeof ownerId !== "string" || ownerId === "") {
    throw new ParitySetupError("test:parity received claims with no valid `sub`.");
  }

  // Read the owner's real timezone once, through RLS, as the owner. The clock
  // parity test compares production `getToday()` against this value, so the
  // zone under test is whatever the database holds — not a constant restated
  // in the suite.
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("timezone")
    .eq("id", ownerId);
  if (profileError || !profile || profile.length !== 1) {
    throw new ParitySetupError(
      "test:parity could not read exactly one owner profile row. Run `npm run auth:reset-local`.",
      { cause: profileError }
    );
  }

  project.provide("parityAuth", {
    url,
    publishableKey,
    accessToken: signInData.session.access_token,
    ownerId,
    ownerTimezone: profile[0].timezone as string,
  });
}
