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
    //
    // `@/lib/types/*` is included alongside `@/lib/types` because the enum
    // label sets and the account-type domain predicates live in
    // `lib/types/enums.ts` — the one layer both this validator and the DB-row
    // mappers may import, so a label set has a single definition. Nothing under
    // lib/types carries a client, a clock, or an env read.
    const ALLOWED = (specifier: string) =>
      specifier === "zod" ||
      specifier === "@/lib/types" ||
      specifier.startsWith("@/lib/types/") ||
      specifier.startsWith("@/lib/validation/");

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

describe("CP3 write surface is exactly accounts + categories + transactions", () => {
  // CP1's version of this block asserted the application was still entirely
  // read-only; CP2's turned it into a two-domain allowlist. CP3 adds the
  // third. The point is unchanged throughout: the set of writable things is a
  // checked fact, and adding a fourth cannot happen quietly.

  it("has Server Actions only for auth, accounts, categories, and transactions", () => {
    // 'use server' marks a file whose exports are independently reachable HTTP
    // endpoints. Every one of them is a new attack surface, so the list is
    // enumerated rather than bounded.
    const serverActionFiles = filesWithCode
      .filter(({ code }) => /^\s*["']use server["']/m.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(serverActionFiles).toEqual([
      "lib/actions/accounts.ts",
      "lib/actions/categories.ts",
      "lib/actions/transactions.ts",
      "lib/auth/actions.ts",
    ]);
  });

  it("has mutation DAL modules only for accounts, categories, and transactions", () => {
    const mutationModules = filesWithCode
      .map(({ repoPath }) => repoPath)
      .filter((repoPath) => repoPath.startsWith("lib/data/mutations/"))
      .sort();

    expect(mutationModules).toEqual([
      "lib/data/mutations/accounts.ts",
      "lib/data/mutations/categories.ts",
      "lib/data/mutations/transactions.ts",
    ]);
  });

  it("has no movement mutation module — CP4 is not implemented", () => {
    // The specific thing CP3 must not have started. A movements module would
    // also fail the enumeration above, but failing here says why.
    const modules = filesWithCode.map(({ repoPath }) => repoPath);
    expect(modules).not.toContain("lib/data/mutations/movements.ts");
    expect(modules).not.toContain("lib/actions/movements.ts");
  });

  it("never assigns `adjustment` as a kind in a write payload", () => {
    // Reconciliation is CP5. The read side handles `adjustment` everywhere —
    // DTO union, badge, filter — and the mutation layer legitimately *compares*
    // against it to refuse editing one, which is why this looks for an
    // assignment (`kind: "adjustment"`) rather than for the word. The mutation
    // layer's kind is typed `OrdinaryTransactionKind` so the type system already
    // forbids it; the payload nonetheless reaches PostgREST as a plain object,
    // and this covers that gap.
    const offenders = filesWithCode
      .filter(
        ({ repoPath }) =>
          repoPath.startsWith("lib/data/mutations/") ||
          repoPath.startsWith("lib/actions/") ||
          repoPath.startsWith("lib/validation/")
      )
      .filter(({ code }) => /\bkind\s*:\s*["'`]adjustment["'`]/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("keeps the ordinary write path free of movement columns", () => {
    // No mutation may set `movement_id` to anything but null. Creating a
    // movement is a two-leg operation over a movement parent — CP4 — and a
    // single-row write that assigned one would leave a movement with one leg,
    // which validate_movement() rejects at COMMIT anyway. Refusing it here
    // means the mistake is caught in review rather than in a failing integration
    // test.
    //
    // Matches an object-literal property only: `movement_id:` followed by
    // something other than `null`, on a line that ends the property with a
    // comma. A TypeScript member declaration (`movement_id: string | null;`)
    // ends in a semicolon and so cannot match, which is what keeps the row-shape
    // interfaces this layer needs from reading as violations.
    // The lookahead absorbs the whitespace itself rather than sitting after a
    // separate `\s*`, which would let the pattern backtrack to a zero-width
    // match and defeat its own negation.
    const assignsNonNullMovement = /movement_id\s*:(?!\s*null\s*,)[^;\n]*,/;

    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/data/mutations/"))
      .filter(({ code }) => assignsNonNullMovement.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);

    // Positive control: the probe would catch the mistake it is looking for.
    // Without this, a regex that stopped matching anything would pass forever.
    expect(assignsNonNullMovement.test("movement_id: input.movementId,")).toBe(true);
    expect(assignsNonNullMovement.test("movement_id: null,")).toBe(false);
    expect(assignsNonNullMovement.test("  movement_id: string | null;")).toBe(false);
  });

  it("issues PostgREST writes only from lib/data/mutations/**", () => {
    // The PostgREST write verbs. A read module or an action that reached for
    // one would be writing outside the one layer where auth re-verification,
    // owner predicates, and the write error mapper live.
    //
    // Scoped to the layers that can reach a client at all. A repo-wide scan
    // would be a worse test, not a stricter one: `.delete(` is also
    // URLSearchParams' and Map's own method (components/transactions/
    // transaction-filters.tsx legitimately calls `params.delete(...)`), and a
    // check that has to be muted for false positives stops being trusted.
    const offenders = filesWithCode
      .filter(
        ({ repoPath }) =>
          (repoPath.startsWith("lib/data/") && !repoPath.startsWith("lib/data/mutations/")) ||
          repoPath.startsWith("lib/actions/")
      )
      .filter(({ code }) => /\.(insert|update|upsert|delete)\s*\(/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("issues a PostgREST delete from exactly one module", () => {
    // CP3 adds the first DELETE in this application, and it is deliberately
    // the only one: accounts, categories, bills and goals are *labels* that
    // historical rows resolve through, so they are archived; a transaction is
    // the history itself and has no correct archived state. This is the
    // source-side half of that claim; the privilege-side half is
    // supabase/tests/database/100-write-grants.sql, which still proves DELETE
    // is granted on transactions and on nothing else.
    const deleters = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/data/mutations/"))
      .filter(({ code }) => /\.delete\s*\(/.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(deleters).toEqual(["lib/data/mutations/transactions.ts"]);
  });

  it("writes to no table other than accounts, categories, and transactions", () => {
    // Every `.from("...")` in the mutation layer, enumerated. The read probes
    // (budgets/bills for the category preflight, bill_occurrences for the
    // delete preflight, account_balances for the account preflight) are
    // legitimate and appear here too — this asserts the *set of relations the
    // layer touches*, which is the number that must not grow silently.
    const relations = new Set<string>();

    for (const { repoPath, code } of filesWithCode) {
      if (!repoPath.startsWith("lib/data/mutations/")) continue;
      for (const match of code.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]/g)) relations.add(match[1]);
    }

    expect([...relations].sort()).toEqual([
      "account_balances",
      "accounts",
      "bill_occurrences",
      "bills",
      "budgets",
      "categories",
      "transactions",
    ]);

    // Stated separately because it is the one name whose absence is a CP4
    // boundary rather than an accident.
    expect(relations.has("movements")).toBe(false);
  });
});
