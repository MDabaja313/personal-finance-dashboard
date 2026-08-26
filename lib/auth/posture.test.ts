import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static regression test for the Phase 5 auth posture. This is not a
 * behavioral test — it greps the repo's own source for the shape of
 * mistakes that would silently reintroduce an insecure pattern (a stray
 * `getSession()` authorization check, a signup path, a misplaced Supabase
 * import, a leaked service-role secret) without any runtime signal.
 *
 * Every check operates on *executable* code with comments stripped, or on
 * parsed import specifiers — never a bare substring search — specifically
 * so a doc comment that discusses `getSession()`/`signUp()` (several exist,
 * on purpose, explaining why they're forbidden) cannot fail this test.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Directories never treated as application source. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "supabase", // migrations/config/generated CLI state — not app source
  "scripts", // local dev/provisioning tooling, not the running application
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Every .ts/.tsx file under app/, components/, lib/, plus root proxy.ts. */
function applicationSourceFiles(): string[] {
  const files = [
    ...walk(join(ROOT, "app")),
    ...walk(join(ROOT, "components")),
    ...walk(join(ROOT, "lib")),
  ];
  files.push(join(ROOT, "proxy.ts"));
  return files;
}

function toRepoRelative(absolutePath: string): string {
  return relative(ROOT, absolutePath).split("\\").join("/");
}

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx");
}

/**
 * Strips /* *\/ block comments and //-line comments so prose that mentions
 * `getSession()`/`signUp()` (by design — that's how this repo documents the
 * ban) can never be mistaken for a call site. Line-comment stripping skips
 * any `//` immediately preceded by `:`, so `https://...` in a doc comment
 * URL doesn't truncate real code that happens to follow it on the same
 * line. Good enough for this repo's actual content — not a general
 * tokenizer — which is why every check below still requires a real call
 * shape (`.getSession(`, `.signUp(`) rather than a bare word match.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => {
      let searchFrom = 0;
      while (true) {
        const at = line.indexOf("//", searchFrom);
        if (at === -1) return line;
        if (line[at - 1] === ":") {
          searchFrom = at + 2;
          continue;
        }
        return line.slice(0, at);
      }
    })
    .join("\n");
}

interface ImportSpecifier {
  specifier: string;
  /** `import type { X } from "..."` — erased at compile time, no runtime access. */
  typeOnly: boolean;
}

/**
 * Extracts static `import ... from "..."` and `require("...")` specifiers,
 * flagging whole-statement `import type` imports. A type-only import is
 * compiled away entirely — it cannot reach a Supabase client, an env var,
 * or any runtime auth logic — so it does not violate a "must not import"
 * layer boundary the way a value import does. This distinction is required
 * by the codebase's own documented design: components/auth/login-form.tsx
 * intentionally does `import type { SignInAction, SignInState } from
 * "@/lib/auth/types"` to get the Server Action's shape at the type level
 * while receiving the action itself as a prop, specifically so it "stays a
 * plain UI component with no reach into lib/** beyond a type" (see that
 * file's own comment).
 */
function extractImportSpecifiers(codeWithoutComments: string): ImportSpecifier[] {
  const specifiers: ImportSpecifier[] = [];
  const importRe = /\bimport\s+(type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of codeWithoutComments.matchAll(importRe)) {
    specifiers.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
  }
  for (const match of codeWithoutComments.matchAll(requireRe)) {
    specifiers.push({ specifier: match[1], typeOnly: false });
  }
  return specifiers;
}

/** True if any *value* (non-type-only) import specifier resolves under `moduleRoot`. */
function importsModuleUnder(specifiers: ImportSpecifier[], moduleRoot: string): boolean {
  return specifiers.some(({ specifier, typeOnly }) => {
    if (typeOnly) return false;
    const normalized = specifier.replace(/^@\//, "");
    return normalized === moduleRoot || normalized.startsWith(`${moduleRoot}/`);
  });
}

const nonTestFiles = applicationSourceFiles().filter((path) => !isTestFile(path));

const filesWithCode = nonTestFiles.map((path) => ({
  path,
  repoPath: toRepoRelative(path),
  code: stripComments(readFileSync(path, "utf8")),
}));

describe("Phase 5 auth posture", () => {
  it("has no executable getSession() authorization call anywhere in application source", () => {
    const offenders = filesWithCode
      .filter(({ code }) => /\.getSession\s*\(/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("has no executable signUp() call site anywhere in application source", () => {
    const offenders = filesWithCode
      .filter(({ code }) => /\.signUp\s*\(/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("has no signup route under app/(auth) or elsewhere in app/", () => {
    const appDir = join(ROOT, "app");
    const signupPaths = walk(appDir)
      .map(toRepoRelative)
      .filter((repoPath) => /(^|\/)signup(\/|\.)/i.test(repoPath));

    expect(signupPaths).toEqual([]);
  });

  it("has no signUp Server Action exported from lib/auth/**", () => {
    const authFiles = filesWithCode.filter(({ repoPath }) => repoPath.startsWith("lib/auth/"));
    const offenders = authFiles
      .filter(({ code }) => /\bexport\s+(?:async\s+)?function\s+signUp\b|\bexport\s+const\s+signUp\b/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("app/** never imports lib/supabase/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("app/"))
      .filter(({ code }) => importsModuleUnder(extractImportSpecifiers(code), "lib/supabase"))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("components/** never imports lib/supabase/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("components/"))
      .filter(({ code }) => importsModuleUnder(extractImportSpecifiers(code), "lib/supabase"))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("components/** never imports lib/auth/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("components/"))
      .filter(({ code }) => importsModuleUnder(extractImportSpecifiers(code), "lib/auth"))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("only lib/auth/**, lib/supabase/** (internally), root proxy.ts, and lib/data/supabase.ts import lib/supabase/**", () => {
    // Phase 6 narrowed rather than widened this allowlist: the DAL's crossing
    // is exactly one file, `lib/data/supabase.ts`, not the `lib/data/`
    // directory. Everything else in lib/data/** reaches the database through
    // that seam's getDataClient()/getOwnerId(), which is separately asserted
    // below and mirrored by a no-restricted-imports rule in eslint.config.mjs.
    const ALLOWED = (repoPath: string) =>
      repoPath.startsWith("lib/auth/") ||
      repoPath.startsWith("lib/supabase/") ||
      repoPath === "proxy.ts" ||
      repoPath === "lib/data/supabase.ts";

    const offenders = filesWithCode
      .filter(({ code }) => importsModuleUnder(extractImportSpecifiers(code), "lib/supabase"))
      .map(({ repoPath }) => repoPath)
      .filter((repoPath) => !ALLOWED(repoPath));

    expect(offenders).toEqual([]);
  });

  it("no lib/data module other than lib/data/supabase.ts imports lib/supabase/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/data/") && repoPath !== "lib/data/supabase.ts")
      .filter(({ code }) => importsModuleUnder(extractImportSpecifiers(code), "lib/supabase"))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("lib/data/supabase.ts exists and is the seam the allowlist assumes", () => {
    // Guards the allowlist entry above against becoming a dead exemption: if
    // the seam is ever renamed or deleted, the permission for that path must
    // not linger silently.
    const seam = filesWithCode.find(({ repoPath }) => repoPath === "lib/data/supabase.ts");

    expect(seam).toBeDefined();
    expect(importsModuleUnder(extractImportSpecifiers(seam!.code), "lib/supabase")).toBe(true);
  });

  it("has no service-role/admin/database secret in application source or .env.example", () => {
    const SECRET_PATTERNS = [
      /service[_-]?role/i,
      /SUPABASE_SERVICE_ROLE_KEY/,
      /SUPABASE_JWT_SECRET/,
      /SUPABASE_DB_PASSWORD/,
      /SECRET_KEY\s*[:=]/,
    ];

    const offenders = filesWithCode
      .filter(({ code }) => SECRET_PATTERNS.some((pattern) => pattern.test(code)))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);

    const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(SECRET_PATTERNS.some((pattern) => pattern.test(envExample))).toBe(false);
  });

  it("project-level signup is disabled, with email/password enabled only for the pre-provisioned owner", () => {
    // supabase/config.toml has two distinct `enable_signup` knobs that are
    // easy to conflate: the project-level [auth] one gates self-service
    // signup entirely (must stay false — there is no signup route, ever),
    // while [auth.email] enable_signup gates the email/password *provider*
    // itself, which must stay true or the one admin-provisioned owner can
    // never call signInWithPassword() — see docs/auth-design.md §1.
    const config = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");

    let section = "";
    const enableSignupBySection: Record<string, string> = {};
    for (const rawLine of config.split(/\r?\n/)) {
      const line = rawLine.trim();
      const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1];
        continue;
      }
      const kv = /^enable_signup\s*=\s*(true|false)\s*$/.exec(line);
      if (kv) enableSignupBySection[section] = kv[1];
    }

    // No other section should introduce its own enable_signup toggle without
    // this test being updated to judge it explicitly.
    expect(Object.keys(enableSignupBySection).sort()).toEqual(["auth", "auth.email", "auth.sms"]);

    expect(enableSignupBySection["auth"]).toBe("false");
    expect(enableSignupBySection["auth.email"]).toBe("true");
    // SMS is an unused provider here — its signup toggle stays disabled.
    expect(enableSignupBySection["auth.sms"]).toBe("false");
  });
});
