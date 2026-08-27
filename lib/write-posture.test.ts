import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Static regression test for the Phase 7 write boundaries — the counterpart to
 * `lib/auth/posture.test.ts`, which does the same job for the Phase 5 auth
 * posture.
 *
 * Two halves, because a documented boundary that nothing checks is a comment:
 *
 * 1. **Negative probes.** Each new ESLint fence is fed a small file that
 *    violates it, through ESLint's own Node API and this repo's real
 *    `eslint.config.mjs`, and is asserted to actually report. A fence that
 *    silently stopped matching — a renamed directory, a `files` glob that no
 *    longer covers the layer, a rule replaced wholesale by a later flat-config
 *    block — passes `npm run lint` on a clean tree and would be invisible
 *    without this. Positive controls run alongside, so a rule that reports on
 *    *everything* (equally useless) fails too.
 * 2. **Source scans.** Executable application source is checked for the
 *    boundary violations a lint fence cannot see: a Server Action appearing
 *    outside the sanctioned files, or a component value-importing the action
 *    layer (ESLint allows the type-only form, and that distinction is worth
 *    asserting on real code rather than only on a probe).
 *
 * Both halves also assert the *Phase 6* fences still fire — the write fences
 * were added by inserting new flat-config blocks after existing ones, and flat
 * config replaces a rule rather than merging it, so an earlier boundary is
 * exactly the thing a careless insertion silently disables.
 */

const ROOT = resolve(import.meta.dirname, "..");

// ============================================================
// Half 1 — ESLint negative probes
// ============================================================

const eslint = new ESLint({ cwd: ROOT });

/** The rule ids ESLint reports for `code`, judged as if it lived at `repoPath`. */
async function ruleIdsFor(repoPath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: join(ROOT, repoPath), warnIgnored: false });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId ?? "fatal"));
}

const IMPORT_RULES = ["no-restricted-imports", "@typescript-eslint/no-restricted-imports"];

async function reportsImportViolation(repoPath: string, code: string): Promise<boolean> {
  const ruleIds = await ruleIdsFor(repoPath, code);
  return ruleIds.some((ruleId) => IMPORT_RULES.includes(ruleId));
}

// ESLint startup dominates these; the assertions themselves are instant.
const PROBE_TIMEOUT = 30_000;

describe("ESLint fences — Phase 7 write boundaries", () => {
  it(
    "lib/actions/** cannot import lib/supabase/**",
    async () => {
      expect(
        await reportsImportViolation(
          "lib/actions/probe.ts",
          `import { createClient } from "@/lib/supabase/server";\nexport const x = createClient;\n`
        )
      ).toBe(true);
    },
    PROBE_TIMEOUT
  );

  it(
    "lib/data/mutations/** cannot import lib/supabase/**, next/navigation, or next/cache",
    async () => {
      for (const specifier of ["@/lib/supabase/server", "next/navigation", "next/cache"]) {
        expect(
          await reportsImportViolation(
            "lib/data/mutations/probe.ts",
            `import * as m from "${specifier}";\nexport const x = m;\n`
          )
        ).toBe(true);
      }
    },
    PROBE_TIMEOUT
  );

  it(
    "components/** cannot value-import lib/actions/**",
    async () => {
      expect(
        await reportsImportViolation(
          "components/probe.tsx",
          `import { succeeded } from "@/lib/actions/result";\nexport const x = succeeded;\n`
        )
      ).toBe(true);
    },
    PROBE_TIMEOUT
  );

  it(
    "components/** may still type-import lib/actions/**",
    async () => {
      // A form needs ActionState/FormAction to call useActionState; a type
      // import is erased at compile time and carries no runtime reach. If this
      // ever reports, the fence has been tightened into something no form can
      // satisfy, and the next person will "fix" it by widening the rule.
      expect(
        await reportsImportViolation(
          "components/probe.tsx",
          `import type { ActionState } from "@/lib/actions/types";\nexport type X = ActionState;\n`
        )
      ).toBe(false);
    },
    PROBE_TIMEOUT
  );

  it(
    "app/** cannot import lib/data/mutations/**",
    async () => {
      expect(
        await reportsImportViolation(
          "app/probe.ts",
          `import { createTransaction } from "@/lib/data/mutations/transactions";\nexport const x = createTransaction;\n`
        )
      ).toBe(true);
    },
    PROBE_TIMEOUT
  );

  it(
    "lib/validation/** cannot import the DAL, Supabase, fixtures, React, or Next",
    async () => {
      for (const specifier of [
        "@/lib/data/accounts",
        "@/lib/supabase/server",
        "@/lib/mock",
        "react",
        "next/headers",
      ]) {
        expect(
          await reportsImportViolation(
            "lib/validation/probe.ts",
            `import * as m from "${specifier}";\nexport const x = m;\n`
          )
        ).toBe(true);
      }
    },
    PROBE_TIMEOUT
  );

  it(
    "lib/validation/** cannot read process.env or the clock",
    async () => {
      expect(await ruleIdsFor("lib/validation/probe.ts", `export const x = process.env.FOO;\n`)).toContain(
        "no-restricted-properties"
      );
      expect(await ruleIdsFor("lib/validation/probe.ts", `export const x = Date.now();\n`)).toContain(
        "no-restricted-properties"
      );
      expect(await ruleIdsFor("lib/validation/probe.ts", `export const x = new Date();\n`)).toContain(
        "no-restricted-syntax"
      );
    },
    PROBE_TIMEOUT
  );

  it(
    "lib/validation/** may still construct a Date from explicit arguments",
    async () => {
      // Calendar-validity checking round-trips through Date.UTC. That is a
      // pure conversion, not a clock read, and the fence must not block it.
      expect(
        await ruleIdsFor(
          "lib/validation/probe.ts",
          `export const x = new Date(Date.UTC(2026, 7, 27)).getUTCDate();\n`
        )
      ).not.toContain("no-restricted-syntax");
    },
    PROBE_TIMEOUT
  );

  it(
    "leaves legal code in each new layer alone",
    async () => {
      // The other half of a negative probe: a rule that reported on
      // everything would pass every assertion above and be worthless.
      expect(
        await reportsImportViolation(
          "lib/validation/probe.ts",
          `import { z } from "zod";\nimport type { CalendarDate } from "@/lib/types";\nexport const x = z.string();\nexport type Y = CalendarDate;\n`
        )
      ).toBe(false);

      expect(
        await reportsImportViolation(
          "lib/actions/probe.ts",
          `import { requireUser } from "@/lib/auth/session";\nimport { attempt } from "@/lib/actions/result";\nexport const x = [requireUser, attempt];\n`
        )
      ).toBe(false);

      expect(
        await reportsImportViolation(
          "lib/data/mutations/probe.ts",
          `import { getDataClient, getOwnerId } from "@/lib/data/supabase";\nexport const x = [getDataClient, getOwnerId];\n`
        )
      ).toBe(false);
    },
    PROBE_TIMEOUT
  );
});

describe("ESLint fences — Phase 6 boundaries still fire", () => {
  it(
    "keeps every pre-existing layer fence enforcing",
    async () => {
      // Flat config replaces a rule wholesale rather than merging it, so a new
      // block inserted after an old one is exactly how an existing boundary
      // gets silently disabled.
      const cases: Array<[string, string]> = [
        ["lib/data/accounts.ts", "@/lib/supabase/server"],
        ["components/probe.tsx", "@/lib/data/accounts"],
        ["components/probe.tsx", "@/lib/supabase/server"],
        ["components/probe.tsx", "@/lib/mock"],
        ["app/probe.ts", "@/lib/supabase/server"],
        ["app/probe.ts", "@/lib/mock"],
        ["lib/finance/probe.ts", "@/lib/data/accounts"],
        ["lib/finance/probe.ts", "@/lib/mock"],
        ["lib/finance/probe.ts", "react"],
      ];

      for (const [repoPath, specifier] of cases) {
        expect(
          await reportsImportViolation(repoPath, `import * as m from "${specifier}";\nexport const x = m;\n`),
          `${repoPath} should not be allowed to import ${specifier}`
        ).toBe(true);
      }

      // The one sanctioned crossing stays open.
      expect(
        await reportsImportViolation(
          "lib/data/supabase.ts",
          `import { createClient } from "@/lib/supabase/server";\nexport const x = createClient;\n`
        )
      ).toBe(false);

      // And lib/finance/** still may not read the clock.
      expect(await ruleIdsFor("lib/finance/probe.ts", `export const x = Date.now();\n`)).toContain(
        "no-restricted-properties"
      );
    },
    PROBE_TIMEOUT
  );
});

// ============================================================
// Half 2 — source scans
// ============================================================

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git", "supabase", "scripts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => {
      let searchFrom = 0;
      for (;;) {
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
  typeOnly: boolean;
}

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

/** True if any *value* import specifier resolves under `moduleRoot`. */
function valueImportsUnder(specifiers: ImportSpecifier[], moduleRoot: string): boolean {
  return specifiers.some(({ specifier, typeOnly }) => {
    if (typeOnly) return false;
    const normalized = specifier.replace(/^@\//, "");
    return normalized === moduleRoot || normalized.startsWith(`${moduleRoot}/`);
  });
}

const filesWithCode = [
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "components")),
  ...walk(join(ROOT, "lib")),
]
  .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
  .map((path) => ({
    repoPath: relative(ROOT, path).split("\\").join("/"),
    code: stripComments(readFileSync(path, "utf8")),
  }));

describe("write-boundary source posture", () => {
  it("components/** never value-imports lib/actions/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("components/"))
      .filter(({ code }) => valueImportsUnder(extractImportSpecifiers(code), "lib/actions"))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("app/** never imports lib/data/mutations/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("app/"))
      .filter(({ code }) =>
        extractImportSpecifiers(code).some(({ specifier }) =>
          specifier.replace(/^@\//, "").startsWith("lib/data/mutations")
        )
      )
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("lib/actions/** never imports lib/supabase/**", () => {
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/actions/"))
      .filter(({ code }) => valueImportsUnder(extractImportSpecifiers(code), "lib/supabase"))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("lib/validation/** imports nothing outside Zod and lib/types", () => {
    // Stated as an allowlist rather than a blocklist: this layer's purity is
    // the reason it can be trusted at the untrusted-input boundary, and a new
    // dependency here should be a deliberate decision, not a drive-by import.
    const ALLOWED = (specifier: string) =>
      specifier === "zod" || specifier === "@/lib/types" || specifier.startsWith("@/lib/validation/");

    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/validation/"))
      .flatMap(({ repoPath, code }) =>
        extractImportSpecifiers(code)
          .map(({ specifier }) => specifier)
          .filter((specifier) => !ALLOWED(specifier))
          .map((specifier) => `${repoPath}: ${specifier}`)
      );

    expect(offenders).toEqual([]);
  });

  it("lib/actions/result.ts inspects no NEXT_* digest and performs no navigation", () => {
    // Both are the documented contract of attempt(): it wraps data work only,
    // so it never needs to recognize — or re-throw — a Next.js control-flow
    // error by its private digest string.
    const result = filesWithCode.find(({ repoPath }) => repoPath === "lib/actions/result.ts");
    expect(result).toBeDefined();

    expect(result!.code).not.toMatch(/NEXT_[A-Z_]+/);
    expect(result!.code).not.toMatch(/\bredirect\s*\(/);
    expect(result!.code).not.toMatch(/\brevalidatePath\s*\(/);
    expect(result!.code).not.toMatch(/\bnotFound\s*\(/);
    expect(result!.code).not.toMatch(/\bdigest\b/);
  });
});

describe("CP1 remains read-only", () => {
  it("has no Server Action outside the auth ones", () => {
    // 'use server' marks a file whose exports are independently reachable
    // HTTP endpoints. CP1 adds the foundation for writes and no writes: the
    // only such file in the application is still lib/auth/actions.ts.
    const serverActionFiles = filesWithCode
      .filter(({ code }) => /^\s*["']use server["']/m.test(code))
      .map(({ repoPath }) => repoPath);

    expect(serverActionFiles).toEqual(["lib/auth/actions.ts"]);
  });

  it("has no mutation DAL layer yet", () => {
    // lib/data/mutations/** is fenced before it exists, exactly as
    // lib/supabase/** was in Phase 2. CP2 creates it.
    const mutationModules = filesWithCode
      .map(({ repoPath }) => repoPath)
      .filter((repoPath) => repoPath.startsWith("lib/data/mutations/"));

    expect(mutationModules).toEqual([]);
  });

  it("issues no PostgREST insert/update/upsert/delete in the data or action layers", () => {
    // The PostgREST write verbs. None may appear while the app is read-only —
    // and `authenticated` has no write GRANT to satisfy one anyway (see
    // supabase/tests/database/100-write-grants.sql).
    //
    // Scoped to the two layers that can reach a client at all. A repo-wide
    // scan would be a worse test, not a stricter one: `.delete(` is also
    // URLSearchParams' and Map's own method (components/transactions/
    // transaction-filters.tsx legitimately calls `params.delete(...)`), and a
    // check that has to be muted for false positives stops being trusted.
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/data/") || repoPath.startsWith("lib/actions/"))
      .filter(({ code }) => /\.(insert|update|upsert|delete)\s*\(/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });
});
