/**
 * Vitest `globalSetup` for the mutation suite: rebuild the local database, then
 * sign in **once** as the real owner.
 *
 * ## Why this rebuilds the database
 *
 * Unlike the parity suite, these tests write. Rows they create survive the run,
 * archive flags they flip stay flipped, and a category renamed by one run would
 * be a different category on the next. Starting from `npm run auth:reset-local`
 * — the same script a developer runs by hand — means every run begins from the
 * committed seed with one login-capable owner, so a failure is a defect and
 * never leftover state. It also gives the suite the fixtures it needs for free:
 * seeded accounts that already have transactions, and seeded categories that
 * are already referenced by transactions, budgets and bills.
 *
 * ## This can only ever touch a local stack
 *
 * Three independent reasons, stated because "the test suite resets the
 * database" is a sentence that should make anyone nervous:
 *
 *  1. `assertLocalStack()` below refuses to continue unless
 *     `NEXT_PUBLIC_SUPABASE_URL` resolves to a loopback host. It runs *before*
 *     anything destructive.
 *  2. `scripts/provision-owner.ts` reads its connection details from
 *     `supabase status` and applies the seed through `docker exec` into the
 *     local container. It has no hosted code path at all.
 *  3. No service-role or admin key is read here, and none is provided to the
 *     workers. The token they receive is an ordinary `authenticated` user JWT
 *     obtained through the publishable key, so RLS applies to every write under
 *     test exactly as it does in production.
 *
 * No password reaches a worker: workers can act as the owner for the life of
 * the run and cannot re-authenticate as them. Nothing is logged.
 *
 * Failure is hard. A run that could not rebuild or could not authenticate
 * throws here and the whole run fails; it never degrades into skipped or
 * vacuous tests.
 */
import { execSync } from "node:child_process";
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

/** Hostnames a local Supabase stack can legitimately be reached on. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** What the workers receive. Deliberately no password and no admin key. */
export interface MutationAuth {
  url: string;
  publishableKey: string;
  accessToken: string;
  ownerId: string;
}

declare module "vitest" {
  interface ProvidedContext {
    mutationAuth: MutationAuth;
  }
}

class MutationSetupError extends Error {}

/** Mirrors the .env.local loader in the parity suite and scripts/verify-auth.ts. */
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

/**
 * Refuses to run against anything but a loopback address.
 *
 * This is the gate in front of a destructive step, so it fails closed on every
 * uncertainty: an unparseable URL is treated as non-local, not as "probably
 * fine".
 */
function assertLocalStack(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new MutationSetupError(
      `test:mutations could not parse NEXT_PUBLIC_SUPABASE_URL as a URL. This suite rebuilds the ` +
        `database it points at and will not run against an address it cannot verify as local.`
    );
  }

  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new MutationSetupError(
      `test:mutations refuses to run against ${hostname}. This suite REBUILDS the database it ` +
        `points at, so it only ever runs against a local Supabase stack. Point ` +
        `NEXT_PUBLIC_SUPABASE_URL at your local stack, or do not run this suite.`
    );
  }
}

export default async function setup(project: TestProject): Promise<void> {
  if (existsSync(ENV_PATH)) loadEnvFile(ENV_PATH);

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new MutationSetupError(
      `test:mutations requires ${missing.join(", ")} to be set (.env.local or the environment).`
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

  // Before anything destructive.
  assertLocalStack(url);

  // The same rebuild `npm run auth:reset-local` performs: migrations, the real
  // owner through the Auth Admin API at the fixed seed UUID, then the committed
  // seed. Inherited stdio so a failure is readable rather than swallowed.
  execSync("npx tsx scripts/provision-owner.ts", { cwd: ROOT, stdio: "inherit" });

  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: process.env.LOCAL_OWNER_EMAIL!,
    password: process.env.LOCAL_OWNER_PASSWORD!,
  });
  if (signInError || !signInData.session) {
    throw new MutationSetupError(
      "test:mutations rebuilt the database but could not sign the owner in.",
      { cause: signInError }
    );
  }

  // The owner id comes from verified claims, never from `getSession()` — the
  // same authorization rule `lib/data/supabase.ts` follows.
  const { data: claimsData, error: claimsError } = await client.auth.getClaims();
  if (claimsError || !claimsData) {
    throw new MutationSetupError("test:mutations signed in but could not verify claims.", {
      cause: claimsError,
    });
  }
  const ownerId = claimsData.claims.sub;
  if (typeof ownerId !== "string" || ownerId === "") {
    throw new MutationSetupError("test:mutations received claims with no valid `sub`.");
  }

  project.provide("mutationAuth", { url, publishableKey, accessToken: signInData.session.access_token, ownerId });
}
