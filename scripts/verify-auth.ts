/**
 * Runtime verification for Phase 5 Checkpoint A4: proves the auth flow
 * actually works against a running local dev server, over real HTTP — not
 * mocked. Complements the static posture regression
 * (lib/auth/posture.test.ts) and the generic-error-mapping unit test
 * (lib/auth/actions.test.ts), neither of which exercises a live request.
 *
 *   npm run auth:verify
 *
 * Requires, in order:
 *   1. `npm run auth:reset-local` — makes LOCAL_OWNER_EMAIL /
 *      LOCAL_OWNER_PASSWORD (read from the gitignored .env.local) a real,
 *      login-capable local owner.
 *   2. `npm run dev` running in another terminal — defaults to
 *      http://localhost:3000; override with VERIFY_AUTH_BASE_URL.
 *
 * No browser, no Playwright. Next.js Server Actions are progressively
 * enhanced: the rendered <form> (see components/auth/login-form.tsx,
 * components/layout/header.tsx) submits as an ordinary
 * multipart/form-data POST carrying hidden `$ACTION_*` fields the server
 * uses to identify and invoke the bound action — exactly what a
 * JS-disabled browser would send. This script parses those hidden fields
 * out of the rendered HTML and replays the same POST via fetch with a
 * small manual cookie jar, so it exercises the real Server Action + cookie
 * path end to end, not a shortcut around it.
 *
 * What this proves, narrowly:
 *   - login cookie issuance
 *   - cookie propagation (this script's own manual jar carries the cookie
 *     across requests, the same way a browser's jar would)
 *   - authenticated session continuity across two different routes
 *   - logout cookie clearing
 * What this does NOT prove: expired-access-token refresh. Forcing that
 * deterministically would require manipulating token expiry out of band,
 * which this script does not do. The proxy's session refresh
 * (lib/supabase/proxy.ts) follows the official Supabase SSR
 * `getClaims()`-in-middleware pattern; that pattern's refresh behavior is
 * not independently re-verified at runtime here — see docs/auth-design.md.
 *
 * The owner's password is read from .env.local and used only as a fetch
 * body value — it is never logged.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = join(ROOT, ".env.local");
const BASE_URL = process.env.VERIFY_AUTH_BASE_URL ?? "http://localhost:3000";

const REQUIRED_ENV = ["LOCAL_OWNER_EMAIL", "LOCAL_OWNER_PASSWORD"] as const;

// ============================================================
// Small helpers — mirrors the style of scripts/provision-owner.ts
// ============================================================

class VerifyError extends Error {}

function fail(message: string): never {
  throw new VerifyError(message);
}

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

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

const problems: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
  } else {
    problems.push(description);
    console.log(`  ✗ ${description}`);
  }
}

// ============================================================
// Cookie jar — manual, since this script drives fetch() directly rather
// than a browser. Only tracks name -> value; attribute handling is limited
// to detecting a clearing Set-Cookie (empty value, Max-Age=0, or an
// Expires date in the past), which is all a same-origin script-driven
// client needs.
// ============================================================

class CookieJar {
  private cookies = new Map<string, string>();

  applySetCookie(setCookieHeaders: string[]): void {
    for (const raw of setCookieHeaders) {
      const firstPair = raw.split(";")[0];
      const eq = firstPair.indexOf("=");
      if (eq === -1) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();

      const clears =
        value === "" ||
        /max-age=0\b/i.test(raw) ||
        /expires=thu,\s*01 jan 1970/i.test(raw);

      if (clears) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }
}

interface ProbeResponse {
  status: number;
  location: string | null;
  body: string;
}

function makeClient(baseUrl: string) {
  const jar = new CookieJar();

  async function request(
    path: string,
    init: { method?: string; body?: FormData } = {}
  ): Promise<ProbeResponse> {
    const res = await fetch(baseUrl + path, {
      method: init.method ?? "GET",
      body: init.body,
      redirect: "manual",
      headers: { cookie: jar.header() },
    });
    const setCookies = res.headers.getSetCookie();
    jar.applySetCookie(setCookies);
    const body = await res.text();
    return { status: res.status, location: res.headers.get("location"), body };
  }

  return { request, jar };
}

// ============================================================
// Server Action form parsing — see the module comment for why this is a
// plain HTML form submission rather than a JS-fetch action invocation.
// ============================================================

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Extracts every `name`/`value` pair from `<input>` tags in the page's one `<form>`. */
function extractFormFields(html: string): Record<string, string> {
  const formMatch = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (!formMatch) fail("Expected exactly one <form> on the page but found none.");

  const fields: Record<string, string> = {};
  for (const [, attrs] of formMatch[1].matchAll(/<input\b([^>]*)>/g)) {
    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    if (!nameMatch) continue;
    const valueMatch = /\bvalue="([^"]*)"/.exec(attrs);
    fields[decodeHtmlEntities(nameMatch[1])] = valueMatch ? decodeHtmlEntities(valueMatch[1]) : "";
  }
  return fields;
}

function formDataFrom(fields: Record<string, string>, overrides: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

// ============================================================
// main
// ============================================================

async function main(): Promise<void> {
  step("Reading local-only owner credentials");
  if (!existsSync(ENV_PATH)) {
    fail(
      `.env.local not found at ${ENV_PATH}. Run \`npm run auth:reset-local\` first ` +
        `(it requires LOCAL_OWNER_EMAIL / LOCAL_OWNER_PASSWORD to already be set there).`
    );
  }
  loadEnvFile(ENV_PATH);
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(`Missing required value(s) in .env.local: ${missing.join(", ")}`);
  }
  const email = process.env.LOCAL_OWNER_EMAIL!;
  const password = process.env.LOCAL_OWNER_PASSWORD!;
  console.log(`  owner: ${maskEmail(email)}`);

  step(`Checking the dev server is reachable at ${BASE_URL}`);
  try {
    await fetch(BASE_URL + "/login", { redirect: "manual" });
  } catch (err) {
    fail(
      `Could not reach ${BASE_URL}. Is \`npm run dev\` running? (${err instanceof Error ? err.message : String(err)})`
    );
  }
  console.log("  ✓ dev server responded");

  // ------------------------------------------------------------
  // Phase A — unauthenticated
  // ------------------------------------------------------------
  step("Unauthenticated: protected route and /login");
  const anon = makeClient(BASE_URL);

  const loggedOutDashboard = await anon.request("/dashboard");
  check(
    loggedOutDashboard.status >= 300 &&
      loggedOutDashboard.status < 400 &&
      loggedOutDashboard.location === "/login",
    `[1] logged-out GET /dashboard redirects to /login (saw ${loggedOutDashboard.status} -> ${loggedOutDashboard.location})`
  );

  const loginPage = await anon.request("/login");
  check(loginPage.status === 200, `[2] logged-out GET /login renders (saw ${loginPage.status})`);
  check(
    loginPage.body.includes('name="email"') && loginPage.body.includes('name="password"'),
    "[2] /login response contains the email and password fields"
  );

  step("Unauthenticated: invalid credentials expose only the generic error");
  const badLoginFields = extractFormFields(loginPage.body);
  const badLogin = await anon.request("/login", {
    method: "POST",
    body: formDataFrom(badLoginFields, { email, password: "definitely-not-the-real-password" }),
  });
  check(
    badLogin.status === 200 && badLogin.location === null,
    `[7] invalid credentials do not redirect (saw ${badLogin.status})`
  );
  check(
    badLogin.body.includes("Invalid email or password."),
    "[7] invalid credentials show the approved generic message"
  );
  check(
    !/invalid login credentials/i.test(badLogin.body) && !/AuthApiError/i.test(badLogin.body),
    "[7] invalid credentials response contains no raw Supabase/Auth error text"
  );

  // ------------------------------------------------------------
  // Phase B — sign in
  // ------------------------------------------------------------
  step("Signing in with valid owner credentials");
  const authed = makeClient(BASE_URL);
  const freshLoginPage = await authed.request("/login");
  const loginFields = extractFormFields(freshLoginPage.body);

  const cookiesBeforeLogin = authed.jar.names();
  const signInResult = await authed.request("/login", {
    method: "POST",
    body: formDataFrom(loginFields, { email, password }),
  });
  check(
    signInResult.status === 303 && signInResult.location === "/dashboard",
    `[3] valid credentials sign in and redirect to /dashboard (saw ${signInResult.status} -> ${signInResult.location})`
  );

  const newCookies = authed.jar.names().filter((name) => !cookiesBeforeLogin.includes(name));
  check(
    newCookies.some((name) => name.startsWith("sb-")),
    `[4] a Supabase session cookie was issued (new cookie names: ${newCookies.join(", ") || "none"})`
  );

  // ------------------------------------------------------------
  // Phase C — authenticated
  // ------------------------------------------------------------
  step("Authenticated: protected routes and session continuity");
  const dashboard = await authed.request("/dashboard");
  check(dashboard.status === 200, `[5] authenticated GET /dashboard succeeds (saw ${dashboard.status})`);

  const secondRoute = await authed.request("/accounts");
  check(
    secondRoute.status === 200,
    `[10] the same session cookie authenticates a second route, /accounts (saw ${secondRoute.status})`
  );

  const authedLogin = await authed.request("/login");
  check(
    authedLogin.status >= 300 && authedLogin.status < 400 && authedLogin.location === "/dashboard",
    `[6] authenticated GET /login redirects to /dashboard (saw ${authedLogin.status} -> ${authedLogin.location})`
  );

  // ------------------------------------------------------------
  // Phase D — sign out
  // ------------------------------------------------------------
  step("Signing out");
  const signOutFields = extractFormFields(dashboard.body);
  const signOutResult = await authed.request("/dashboard", {
    method: "POST",
    body: formDataFrom(signOutFields, {}),
  });
  check(
    signOutResult.status === 303 && signOutResult.location === "/login",
    `[8] signing out redirects to /login (saw ${signOutResult.status} -> ${signOutResult.location})`
  );
  check(
    !authed.jar.names().some((name) => name.startsWith("sb-")),
    "[8] the Supabase session cookie is cleared after sign-out"
  );

  const afterLogout = await authed.request("/dashboard");
  check(
    afterLogout.status >= 300 && afterLogout.status < 400 && afterLogout.location === "/login",
    `[9] the protected route is inaccessible immediately after logout (saw ${afterLogout.status} -> ${afterLogout.location})`
  );

  // ------------------------------------------------------------
  if (problems.length > 0) {
    fail(`${problems.length} check(s) failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  console.log(
    "\n✅ auth:verify passed. Expired-access-token refresh is not runtime-tested by this " +
      "script — see the module comment and docs/auth-design.md.\n"
  );
}

main().catch((error: unknown) => {
  const message = error instanceof VerifyError ? error.message : String(error);
  console.error(`\n❌ auth:verify failed.\n${message}\n`);
  process.exitCode = 1;
});
