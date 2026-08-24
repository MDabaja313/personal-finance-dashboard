/**
 * Rebuilds the LOCAL database around one real, login-capable owner.
 *
 *   npm run auth:reset-local
 *
 * Why this exists: `supabase/seed.sql` can only insert a *placeholder*
 * `auth.users` row (see scripts/generate-seed.ts). A row written straight
 * into `auth.users` by SQL is not a usable account — GoTrue owns the
 * password hash, the `auth.identities` row, and the rest of its internals,
 * and a hand-written row is effectively invisible to the Auth API and can
 * never sign in. Hand-writing those internals in the seed is explicitly
 * out of bounds. So the owner has to be created through the supported Auth
 * Admin API, and the seed has to attach itself to that user rather than
 * try to create one.
 *
 * The order below is therefore load-bearing:
 *
 *   1. supabase db reset --no-seed        empty schema, no seed applied
 *   2. Auth Admin API createUser(...)     the real owner, at the fixed
 *                                         seed UUID, email-confirmed
 *   3. docker exec ... psql < seed.sql    fixture data; its auth.users
 *                                         insert is ON CONFLICT (id) DO
 *                                         NOTHING, so step 2's user wins
 *   4. verify everything, or fail loudly
 *
 * Step 3 goes straight at the local DB container via `docker exec ... psql`
 * rather than `supabase db query --local --file`: the installed CLI
 * (2.115.0) rejects any multi-statement SQL file with "cannot insert
 * multiple commands into a prepared statement" — confirmed with a bare
 * `select 1; select 2;` — so it cannot run this seed's begin/commit block.
 * `supabase db reset` applies the same file fine through its own code
 * path; only the ad hoc `db query` command has this limitation. Streaming
 * to `psql` with `-v ON_ERROR_STOP=1` preserves the seed's transaction
 * exactly as written and fails loudly on the first error, same as before.
 *
 * Credentials: the owner's email/password come from the gitignored
 * .env.local. The local admin key is read from `supabase status` at
 * runtime and held in memory only — never written to a file, never
 * printed. Nothing here touches the hosted project.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { mockCategories } from "@/lib/mock";
import { SEED_USER_ID } from "./seed-identity";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = join(ROOT, ".env.local");
const CONFIG_PATH = join(ROOT, "supabase", "config.toml");
const SEED_PATH = join(ROOT, "supabase", "seed.sql");

const REQUIRED_ENV = ["LOCAL_OWNER_EMAIL", "LOCAL_OWNER_PASSWORD", "OWNER_TIMEZONE"] as const;

// Docker's own container-name constraint — validated against before the
// name is used anywhere, even though it only ever reaches docker/psql
// through an argv array (never a shell string).
const DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// ============================================================
// Small helpers
// ============================================================

class ProvisionError extends Error {}

function fail(message: string): never {
  throw new ProvisionError(message);
}

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

/** Never log a full owner email into a shared terminal transcript. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Minimal .env parser. Deliberately dependency-free — this runs before
 * anything else and must not need an install step of its own.
 */
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

function run(command: string): void {
  execSync(command, { cwd: ROOT, stdio: "inherit" });
}

/**
 * Runs SQL through the local CLI and returns the result rows.
 * The SQL goes via a temp file rather than an argv string so quoting is
 * never at the mercy of the host shell.
 */
function query(sql: string): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "pfd-provision-"));
  const file = join(dir, "query.sql");
  try {
    writeFileSync(file, sql, "utf8");
    const raw = execSync(`npx supabase db query --local --output-format json --file "${file}"`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The CLI prints a human "Connecting to local database..." line ahead
    // of the JSON document.
    const start = raw.indexOf("{");
    if (start === -1) fail(`Unexpected output from \`supabase db query\`:\n${raw}`);
    const parsed = JSON.parse(raw.slice(start)) as { rows?: Record<string, unknown>[] };
    return parsed.rows ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs a non-SELECT statement through the local CLI. Separate from
 * query(): `--output-format json` only shapes SELECT output — an
 * UPDATE/INSERT/DELETE prints a plain command tag (e.g. "UPDATE 1")
 * instead, which query()'s JSON parsing would reject.
 */
function execute(sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), "pfd-provision-"));
  const file = join(dir, "execute.sql");
  try {
    writeFileSync(file, sql, "utf8");
    execSync(`npx supabase db query --local --file "${file}"`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const problems: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    ok(description);
  } else {
    problems.push(description);
    console.log(`  ✗ ${description}`);
  }
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  fail(`verification query returned no usable value for "${key}"`);
}

// ============================================================
// 0. Local-only configuration
// ============================================================

function readOwnerConfig(): { email: string; password: string; timezone: string } {
  if (!existsSync(ENV_PATH)) {
    fail(
      `.env.local not found at ${ENV_PATH}.\n` +
        `Create it locally (it is gitignored — never commit it) and set:\n` +
        REQUIRED_ENV.map((name) => `  ${name}=`).join("\n")
    );
  }
  loadEnvFile(ENV_PATH);

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(
      `Missing required local-only value(s) in .env.local:\n` +
        missing.map((name) => `  ${name}=`).join("\n") +
        `\nPopulate them yourself — this script will not invent credentials. ` +
        `.env.local is gitignored; never put real values in .env.example.`
    );
  }

  return {
    email: process.env.LOCAL_OWNER_EMAIL!,
    password: process.env.LOCAL_OWNER_PASSWORD!,
    timezone: process.env.OWNER_TIMEZONE!,
  };
}

/**
 * Local stack URL + keys, read fresh from the CLI. stdout is piped and
 * parsed rather than inherited: that output contains the service/admin
 * key and the JWT secret, which must never reach the terminal.
 */
function readLocalStatus(): Record<string, string> {
  let raw: string;
  try {
    raw = execSync("npx supabase status -o env", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    fail("`supabase status` failed. Is the local stack running? Try `npx supabase start`.");
  }
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * The local DB container's project_id, read from supabase/config.toml
 * rather than hardcoded — so this script keeps working if the project is
 * ever renamed.
 */
function readProjectId(): string {
  if (!existsSync(CONFIG_PATH)) fail(`${CONFIG_PATH} not found.`);
  const text = readFileSync(CONFIG_PATH, "utf8");
  const match = /^project_id\s*=\s*"([^"]*)"/m.exec(text);
  const projectId = match?.[1];
  if (!projectId || !DOCKER_NAME_PATTERN.test(projectId)) {
    fail(
      `Could not read a valid project_id from ${CONFIG_PATH}. ` +
        `Expected a top-level line like project_id = "your-project" ` +
        `matching ${DOCKER_NAME_PATTERN}.`
    );
  }
  return projectId;
}

/** Matches the naming the Supabase CLI gives the local Postgres container. */
function localDbContainerName(projectId: string): string {
  return `supabase_db_${projectId}`;
}

/** Fails loudly, with no secret in the message, if the container isn't up. */
function assertDockerContainerRunning(containerName: string): void {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", containerName], {
    encoding: "utf8",
  });
  if (result.error) {
    fail(`Could not run \`docker inspect\` (${result.error.message}). Is Docker installed and on PATH?`);
  }
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    fail(
      `Local Supabase DB container "${containerName}" is not running.\n` +
        `Start the local stack first: \`npx supabase start\`.`
    );
  }
}

/**
 * Streams supabase/seed.sql into `docker exec -i <container> psql`, over
 * an argv array — never a shell string built from the container name or
 * any other value. `-v ON_ERROR_STOP=1` makes psql fail loudly (nonzero
 * exit) on the seed's first error, and the seed's own begin/commit block
 * is sent through unmodified.
 */
function applySeedViaDocker(containerName: string, seedPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "docker",
      ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      { stdio: ["pipe", "inherit", "inherit"] }
    );

    child.on("error", (err) => {
      reject(new ProvisionError(`Failed to launch \`docker exec\`: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new ProvisionError(`\`docker exec ... psql\` exited with code ${code} while applying ${seedPath}.`));
    });

    const source = createReadStream(seedPath);
    source.on("error", (err) => {
      reject(new ProvisionError(`Failed to read ${seedPath}: ${err.message}`));
    });
    source.pipe(child.stdin);
  });
}

/** Per-table insert counts declared by the generated seed. */
function seedInsertCounts(): Map<string, number> {
  const sql = readFileSync(SEED_PATH, "utf8");
  const counts = new Map<string, number>();
  for (const match of sql.matchAll(/^insert into public\.(\w+)\b/gm)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  if (counts.size === 0) fail(`No public inserts found in ${SEED_PATH}. Run \`npm run seed:generate\`.`);
  return counts;
}

// ============================================================
// main
// ============================================================

async function main(): Promise<void> {
  const owner = readOwnerConfig();
  const expectedCounts = seedInsertCounts();

  step("Reading local Supabase status");
  const status = readLocalStatus();
  const apiUrl = status.API_URL;
  const publishableKey = status.PUBLISHABLE_KEY;
  // Newer CLIs expose SECRET_KEY; older ones only SERVICE_ROLE_KEY. Either
  // is the local admin credential — used in memory here and nowhere else.
  const adminKey = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  if (!apiUrl || !publishableKey || !adminKey) {
    fail("Could not read API_URL / PUBLISHABLE_KEY / admin key from `supabase status`.");
  }
  ok(`local API at ${apiUrl}`);

  step("Resetting the local database (migrations only, no seed)");
  run("npx supabase db reset --no-seed");

  step("Creating the owner through the Auth Admin API");
  const admin = createClient(apiUrl, adminKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const created = await admin.auth.admin.createUser({
    id: SEED_USER_ID,
    email: owner.email,
    password: owner.password,
    email_confirm: true,
  });
  if (created.error) fail(`Auth Admin API rejected the owner: ${created.error.message}`);
  if (created.data.user?.id !== SEED_USER_ID) {
    fail(`Auth Admin API created ${created.data.user?.id ?? "no user"}, expected ${SEED_USER_ID}.`);
  }
  ok(`owner ${maskEmail(owner.email)} created at ${SEED_USER_ID}`);

  step("Locating the local database container");
  const projectId = readProjectId();
  const containerName = localDbContainerName(projectId);
  assertDockerContainerRunning(containerName);
  ok(`container ${containerName} is running`);

  step("Applying supabase/seed.sql (docker exec ... psql)");
  await applySeedViaDocker(containerName, SEED_PATH);
  ok("seed applied");

  step("Applying the owner timezone");
  execute(
    `update public.profiles set timezone = ${sqlLiteral(owner.timezone)} where id = ${sqlLiteral(SEED_USER_ID)};`
  );

  step("Verifying");

  const listed = await admin.auth.admin.listUsers();
  if (listed.error) fail(`Auth Admin API listUsers failed: ${listed.error.message}`);
  check(listed.data.users.length === 1, `Auth Admin API sees exactly one user (saw ${listed.data.users.length})`);
  check(
    listed.data.users[0]?.id === SEED_USER_ID,
    `the one Auth user is the fixed seed UUID ${SEED_USER_ID}`
  );

  const anon = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await anon.auth.signInWithPassword({
    email: owner.email,
    password: owner.password,
  });
  check(!signedIn.error, `signInWithPassword succeeds${signedIn.error ? ` (${signedIn.error.message})` : ""}`);
  check(signedIn.data.user?.id === SEED_USER_ID, "signed-in user.id equals the fixed seed UUID");
  check(
    (signedIn.data.user?.identities ?? []).some((identity) => identity.provider === "email"),
    "signed-in user has an identity with provider=email"
  );
  if (signedIn.data.session) await anon.auth.signOut();

  const tables = [...expectedCounts.keys()].sort();
  const ownerColumn = (table: string) => (table === "profiles" ? "id" : "user_id");
  const ownerId = sqlLiteral(SEED_USER_ID);
  const selects = [
    `(select count(*) from auth.users)::int as auth_users_total`,
    `(select count(*) from auth.identities where user_id = ${ownerId} and provider = 'email')::int as email_identities`,
    `(select timezone from public.profiles where id = ${ownerId}) as owner_timezone`,
    ...tables.flatMap((table) => [
      `(select count(*) from public.${table})::int as cnt_${table}`,
      `(select count(*) from public.${table} where ${ownerColumn(table)} <> ${ownerId})::int as foreign_${table}`,
    ]),
  ];
  const [row] = query(`select\n  ${selects.join(",\n  ")};`);
  if (!row) fail("verification query returned no rows");

  check(num(row, "auth_users_total") === 1, "auth.users holds exactly one row");
  check(num(row, "email_identities") === 1, "auth.identities holds exactly one email identity for the owner");
  check(num(row, "cnt_profiles") === 1, "public.profiles holds exactly one row");
  check(num(row, "foreign_profiles") === 0, "the profile row is the owner's");
  check(
    row.owner_timezone === owner.timezone,
    `profiles.timezone is OWNER_TIMEZONE (saw ${String(row.owner_timezone)})`
  );
  check(
    num(row, "cnt_categories") === mockCategories.length,
    `public.categories holds the ${mockCategories.length} default categories`
  );

  for (const table of tables) {
    const expected = expectedCounts.get(table)!;
    check(num(row, `cnt_${table}`) === expected, `public.${table} has ${expected} seeded row(s)`);
    check(num(row, `foreign_${table}`) === 0, `every public.${table} row belongs to the owner`);
  }

  if (problems.length > 0) {
    fail(`${problems.length} verification check(s) failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  console.log(
    `\n✅ Local owner ready. Sign in at /login as ${maskEmail(owner.email)} with LOCAL_OWNER_PASSWORD.\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof ProvisionError ? error.message : String(error);
  console.error(`\n❌ auth:reset-local failed.\n${message}\n`);
  process.exitCode = 1;
});
