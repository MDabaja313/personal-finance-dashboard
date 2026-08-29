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

describe("CP7 write surface is exactly accounts + categories + transactions + movements + reconciliation + budgets + goals + goal-contributions + bills + bill-occurrences", () => {
  // CP1's version of this block asserted the application was still entirely
  // read-only; CP2's turned it into a two-domain allowlist; CP3 added the
  // third; CP4 the fourth; CP5 added reconciliation, deliberately NOT a fifth
  // table (it writes `transactions` through an RPC and opens no new relation
  // at all). CP6 added three genuinely new tables — budgets, goals,
  // goal_contributions. CP7 adds the last two, `bills` and `bill_occurrences`,
  // and with them the schema's first scheduler bridge. The point is unchanged
  // throughout: the set of writable things is a checked fact, and adding to it
  // cannot happen quietly.

  it("has Server Actions only for auth, accounts, categories, transactions, movements, reconciliation, budgets, goals, goal-contributions, bills, and bill-occurrences", () => {
    // 'use server' marks a file whose exports are independently reachable HTTP
    // endpoints. Every one of them is a new attack surface, so the list is
    // enumerated rather than bounded.
    //
    // `lib/actions/today.ts` is deliberately absent and must stay absent: it
    // is an internal helper the dated-write action modules import, and marking
    // it would publish an endpoint for something that is not one.
    const serverActionFiles = filesWithCode
      .filter(({ code }) => /^\s*["']use server["']/m.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(serverActionFiles).toEqual([
      "lib/actions/accounts.ts",
      "lib/actions/bill-occurrences.ts",
      "lib/actions/bills.ts",
      "lib/actions/budgets.ts",
      "lib/actions/categories.ts",
      "lib/actions/goal-contributions.ts",
      "lib/actions/goals.ts",
      "lib/actions/movements.ts",
      "lib/actions/reconciliation.ts",
      "lib/actions/transactions.ts",
      "lib/auth/actions.ts",
    ]);
  });

  it("has mutation DAL modules only for the ten write domains plus the two maintenance bridges", () => {
    const mutationModules = filesWithCode
      .map(({ repoPath }) => repoPath)
      .filter((repoPath) => repoPath.startsWith("lib/data/mutations/"))
      .sort();

    expect(mutationModules).toEqual([
      "lib/data/mutations/accounts.ts",
      "lib/data/mutations/bill-occurrences.ts",
      "lib/data/mutations/bill-schedule.ts",
      "lib/data/mutations/bills.ts",
      "lib/data/mutations/budgets.ts",
      "lib/data/mutations/categories.ts",
      "lib/data/mutations/goal-contributions.ts",
      "lib/data/mutations/goals.ts",
      "lib/data/mutations/movements.ts",
      "lib/data/mutations/reconciliation.ts",
      "lib/data/mutations/snapshots.ts",
      "lib/data/mutations/transactions.ts",
    ]);
  });

  it("has no profile or snapshot write surface — the two tables that stay read-only", () => {
    // The CP7 counterpart of the assertion that used to name bills here. Every
    // finance domain is now writable, so what this guards is the pair that is
    // not and never will be: `profiles` (the owner's own timezone row, written
    // only by provisioning) and `net_worth_snapshots` (a derived artifact,
    // written only by the Phase 4 writer behind CP5's zero-parameter bridge).
    // Each would also fail the enumerations above, but failing here says which
    // one and why.
    const modules = filesWithCode.map(({ repoPath }) => repoPath);
    for (const domain of ["profiles", "net-worth-snapshots", "snapshots"]) {
      expect(modules).not.toContain(`lib/actions/${domain}.ts`);
    }
    expect(modules).not.toContain("lib/data/mutations/profiles.ts");

    // And no mutation module issues a PostgREST write against either table.
    // `snapshots.ts` reaches the snapshot bridge as an RPC and touches no
    // relation at all, which the relation enumeration below re-states.
    const offenders = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/data/mutations/"))
      .filter(({ code }) => /\.from\(\s*["'`](profiles|net_worth_snapshots)["'`]/.test(code))
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("keeps bill tracking free of ledger writes", () => {
    // The load-bearing CP7 property, as a source fact: creating, editing,
    // archiving a bill, and marking an occurrence paid or skipped write no
    // transaction, no movement, no account and no budget — so no balance, no
    // economic total and no net-worth figure can move. The integration half is
    // tests/mutations/bill-occurrences.test.ts, which reads every one of those
    // figures back before and after.
    const billModules = filesWithCode.filter(
      ({ repoPath }) =>
        repoPath === "lib/data/mutations/bills.ts" ||
        repoPath === "lib/data/mutations/bill-occurrences.ts" ||
        repoPath === "lib/data/mutations/bill-schedule.ts"
    );
    expect(billModules).toHaveLength(3);

    for (const { repoPath, code } of billModules) {
      // No write verb against any relation but the two bill relations. The
      // occurrence module *reads* `transactions` to validate a link, which is
      // why this checks the write verbs rather than the relation name.
      for (const relation of ["transactions", "movements", "accounts", "budgets", "goals"]) {
        expect(
          new RegExp(`\\.from\\(\\s*["'\`]${relation}["'\`]\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\s*\\(`).test(
            code
          ),
          `${repoPath} must not write ${relation}`
        ).toBe(false);
      }

      // And no snapshot refresh: bill tracking changes no figure a snapshot
      // records, so calling the bridge would be a write with nothing to write.
      expect(code, `${repoPath} must not refresh the net-worth snapshot`).not.toMatch(
        /net_worth_snapshot|refreshCurrentSnapshot/
      );
    }
  });

  it("keeps bill create/edit/archive off the best-effort scheduler helper", () => {
    // The correctness-critical half of CP7's atomicity story, as a source fact.
    //
    // `lib/data/mutations/bill-schedule.ts` is best-effort: it runs *after* a
    // committed write and swallows its own failure. That is correct for a
    // rolling-horizon top-up after an occurrence status change, and it would be
    // wrong for create, a terms edit, or unarchive — those must generate or
    // rebuild in the SAME transaction as the parent write, so a scheduler
    // failure rolls the parent back. They do, because
    // `public.create_bill`/`replace_bill`/`set_bill_archived` call
    // `public.maintain_bill_schedule` from inside their own function bodies.
    //
    // So `lib/data/mutations/bills.ts` must never import the helper at all. If
    // it ever does, someone has moved a required rebuild to a path that can
    // silently not happen. 180-bill-writes.sql proves the database half by
    // forcing a generation failure and asserting no bill row survives.
    const billsModule = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/data/mutations/bills.ts"
    );
    expect(billsModule).toBeDefined();
    expect(billsModule!.code).not.toMatch(/bill-schedule/);
    expect(billsModule!.code).not.toMatch(/maintainBillSchedule/);

    // And the helper is reachable from exactly one module: the occurrence
    // state-machine one, where a missed top-up is recoverable.
    const importers = filesWithCode
      .filter(({ code }) => /@\/lib\/data\/mutations\/bill-schedule/.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(importers).toEqual(["lib/data/mutations/bill-occurrences.ts"]);
  });

  it("never names a private recurrence function anywhere in application code", () => {
    // `authenticated` has no USAGE on the `private` schema at all
    // (090-privileges.sql), so naming one of these would be a call that could
    // only ever fail — and, more to the point, an attempt to generate
    // occurrences for an owner and a horizon of the caller's choosing. The
    // public bridge takes neither: an owned bill id and a boolean, and nothing
    // else.
    const offenders = filesWithCode
      .filter(({ code }) =>
        /generate_bill_occurrences|next_bill_occurrence_date|private\./.test(code)
      )
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("keeps goal_contributions strictly append-only in source", () => {
    // The database backstop (no UPDATE/DELETE grant, ever) is
    // 100-write-grants.sql; this is the source-side statement that the one
    // module that could reach this table never even attempts either verb
    // against it.
    const goalContributionModule = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/data/mutations/goal-contributions.ts"
    );
    expect(goalContributionModule).toBeDefined();
    expect(goalContributionModule!.code).not.toMatch(/\.update\s*\(/);
    expect(goalContributionModule!.code).not.toMatch(/\.delete\s*\(/);
  });

  it("names the net-worth snapshot from exactly one module", () => {
    // CP4's version of this test asserted that *nothing* in the write layers
    // mentioned a snapshot, because CP4 deliberately wrote none. CP5 owns
    // snapshots, so the assertion inverts rather than disappears: the bridge is
    // reachable from one place, and a second module reaching for it — or an
    // action calling it directly, outside the layer where auth re-verification
    // and the write error mapper live — fails here.
    //
    // Scoped to the write layers. `lib/data/net-worth.ts` legitimately *reads*
    // the table; that is the Phase 6 read path and has nothing to do with this.
    const namers = filesWithCode
      .filter(
        ({ repoPath }) =>
          repoPath.startsWith("lib/data/mutations/") || repoPath.startsWith("lib/actions/")
      )
      .filter(({ code }) => /net_worth_snapshot/.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(namers).toEqual(["lib/data/mutations/snapshots.ts"]);
  });

  it("never names a private snapshot writer anywhere in application code", () => {
    // `authenticated` has no USAGE on the `private` schema at all
    // (090-privileges.sql), so naming one of these would be a call that could
    // only ever fail — and, more to the point, an attempt to write a snapshot
    // for an owner and a month of the caller's choosing. The public bridge
    // takes neither, and the range writer has no wrapper of any kind.
    const offenders = filesWithCode
      .filter(({ code }) =>
        /write_net_worth_snapshots_for_range|private\.write_net_worth_snapshot/.test(code)
      )
      .map(({ repoPath }) => repoPath);

    expect(offenders).toEqual([]);
  });

  it("calls a database function only from the mutation layer", () => {
    // `.rpc(...)` is a second write path alongside `.insert`/`.update`/
    // `.delete`. It belongs in exactly the same place as every other write:
    // the one layer where auth re-verification, owner predicates, and the
    // write error mapper live.
    const callers = filesWithCode
      .filter(({ code }) => /\.rpc\s*\(/.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(callers).toEqual([
      "lib/data/mutations/bill-schedule.ts",
      "lib/data/mutations/bills.ts",
      "lib/data/mutations/movements.ts",
      "lib/data/mutations/reconciliation.ts",
      "lib/data/mutations/snapshots.ts",
    ]);
  });

  it("names exactly the eight RPCs authenticated may execute", () => {
    // Enumerated rather than bounded, for the same reason the relation list
    // below is: a function is a privilege surface, and `authenticated` holds
    // EXECUTE on exactly these eight. 090-privileges.sql asserts the database
    // half of the same claim, as a sorted list of every function in `public`
    // that role can execute.
    //
    // Two shapes are scanned because the two *bridge* modules name their RPC
    // through a module constant (`.rpc(REFRESH_RPC)`, `.rpc(MAINTAIN_RPC)`),
    // deliberately: each exists to have exactly one name in it, and a literal
    // at the call site would put the same string in two places.
    const BRIDGE_MODULES = new Set([
      "lib/data/mutations/snapshots.ts",
      "lib/data/mutations/bill-schedule.ts",
    ]);

    const invoked = new Set<string>();

    for (const { repoPath, code } of filesWithCode) {
      for (const match of code.matchAll(/\.rpc\(\s*["'`]([a-z_]+)["'`]/g)) invoked.add(match[1]);
      if (!BRIDGE_MODULES.has(repoPath)) continue;
      for (const match of code.matchAll(/^const [A-Z_]+ = "([a-z_]+)";$/gm)) invoked.add(match[1]);
    }

    expect([...invoked].sort()).toEqual([
      "create_bill",
      "create_movement",
      "maintain_bill_schedule",
      "reconcile_account",
      "refresh_current_net_worth_snapshot",
      "replace_bill",
      "replace_movement",
      "set_bill_archived",
    ]);
  });

  it("never assigns `adjustment` as a kind in a write payload", () => {
    // Still true after CP5, and now load-bearing in a way it was not before.
    // Reconciliation writes an adjustment — but it does so *inside*
    // `public.reconcile_account`, in SQL, where the kind is a literal no
    // caller can influence. No TypeScript payload names the kind at all, so
    // there is no client-facing path that chooses it, and
    // `transactions_update_own_ordinary`'s WITH CHECK still refuses to let an
    // ordinary row become one.
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

  it("keeps every PostgREST write path free of movement columns", () => {
    // No mutation may set `movement_id` to anything but null. A movement's
    // legs are written by `public.create_movement` in SQL; a single-row write
    // that assigned one would leave a movement with one leg, which
    // validate_movement() rejects at COMMIT anyway.
    //
    // Matches an object-literal property only: `movement_id:` followed by
    // something other than `null`, on a line that ends the property with a
    // comma. A TypeScript member declaration (`movement_id: string | null;`)
    // ends in a semicolon and so cannot match, which is what keeps the
    // row-shape interfaces this layer needs from reading as violations.
    // The lookahead absorbs the whitespace itself rather than sitting after a
    // separate `\s*`, which would let the pattern backtrack to a zero-width
    // match and defeat its own negation.
    //
    // The leading `(?<![A-Za-z0-9_])` keeps the *column* apart from the RPC
    // parameter `p_movement_id`, which the movement module legitimately passes.
    const assignsNonNullMovement = /(?<![A-Za-z0-9_])movement_id\s*:(?!\s*null\s*,)[^;\n]*,/;

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
    // And the exemption is exactly as narrow as it claims to be.
    expect(assignsNonNullMovement.test("p_movement_id: input.id,")).toBe(false);
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

  it("issues a PostgREST delete from exactly four modules", () => {
    // CP3 added the first DELETE in this application; CP4 the second; CP5 the
    // third; CP6 the fourth (budgets). All four are deliberate and none
    // generalizes: accounts, categories, bills and goals are *labels* that
    // historical rows resolve through, so they are archived, while a
    // transaction is the history itself, a movement is the only correct unit
    // for removing a pair of legs, an adjustment is removable precisely
    // because it is not editable, and a budget is planning metadata with no
    // history to lose.
    //
    // CP5 added no privilege to make its delete possible — it reuses CP3's
    // `DELETE` grant and `transactions_delete_own_non_movement`, which
    // deliberately never excluded adjustments. CP6's budgets delete *is* a new
    // privilege, granted for the first time in
    // `20260830120001_budget_goal_writes.sql`. This is the source-side half of
    // both claims; the privilege-side half is
    // supabase/tests/database/100-write-grants.sql.
    const deleters = filesWithCode
      .filter(({ repoPath }) => repoPath.startsWith("lib/data/mutations/"))
      .filter(({ code }) => /\.delete\s*\(/.test(code))
      .map(({ repoPath }) => repoPath)
      .sort();

    expect(deleters).toEqual([
      "lib/data/mutations/budgets.ts",
      "lib/data/mutations/movements.ts",
      "lib/data/mutations/reconciliation.ts",
      "lib/data/mutations/transactions.ts",
    ]);
  });

  it("writes to no table other than accounts, categories, transactions, movements, budgets, and goals", () => {
    // Every `.from("...")` in the mutation layer, enumerated. The read probes
    // (budgets/bills for the category preflight, bill_occurrences for the
    // delete preflight, account_balances for the account and reconcile
    // preflights, goals for the contribution preflight) are legitimate and
    // appear here too — this asserts the *set of relations the layer
    // touches*, which is the number that must not grow silently. CP5 added no
    // name to it: reconciliation reads `account_balances` and reads/deletes
    // `transactions`, both already here. CP6 adds three: `budgets`, `goals`,
    // and `goal_contributions`; `net_worth_snapshots` stays absent because
    // application code never touches that table at all.
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
      "goal_contributions",
      "goals",
      "movements",
      "transactions",
    ]);

    // Stated separately because it is the one name whose *use* must stay
    // narrow: `movements` appears here for the parent delete only. The legs are
    // written inside `public.create_movement`, never by a statement from this
    // layer, which is why `transactions` is not reachable from the movement
    // module at all.
    const movementModule = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/data/mutations/movements.ts"
    );
    expect(movementModule).toBeDefined();
    expect(movementModule!.code).not.toMatch(/\.from\(\s*["'`]transactions["'`]/);

    // And the snapshot bridge touches no relation whatsoever — it is one RPC
    // and nothing else. A `.from(...)` appearing there would mean application
    // code had started reading or writing snapshot data directly.
    const snapshotModule = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/data/mutations/snapshots.ts"
    );
    expect(snapshotModule).toBeDefined();
    expect(snapshotModule!.code).not.toMatch(/\.from\(/);
  });

  it("keeps the movement, ordinary and adjustment surfaces disjoint", () => {
    // The property CP4 established and CP5 must preserve, now checked in three
    // directions. The database enforces the same splits independently — both
    // ordinary write policies carry `movement_id IS NULL`, and the UPDATE
    // policy also carries `kind <> 'adjustment'` — so these are the
    // source-side statements of rules that hold regardless.
    const transactionModule = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/data/mutations/transactions.ts"
    );
    expect(transactionModule).toBeDefined();
    expect(transactionModule!.code).not.toMatch(/\.from\(\s*["'`]movements["'`]/);
    expect(transactionModule!.code).not.toMatch(/\.rpc\s*\(/);

    // Reconciliation never touches a movement, in either direction.
    const reconciliationModule = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/data/mutations/reconciliation.ts"
    );
    expect(reconciliationModule).toBeDefined();
    expect(reconciliationModule!.code).not.toMatch(/\.from\(\s*["'`]movements["'`]/);

    // And it issues no UPDATE against anything: an adjustment is not editable,
    // and reconciliation does not restate history — it appends a dated
    // correction. A `.update(` here would be one of those two mistakes.
    expect(reconciliationModule!.code).not.toMatch(/\.update\s*\(/);
  });

  it("keeps the reconciliation surface free of a kind, a category, or an amount field", () => {
    // A reconciliation submission is an account, a date, and an observed
    // balance. If a `kind`, `categoryId`, `movementId` or `amount` field ever
    // appeared in what the action reads, the surface would have quietly become
    // a second transaction entry form — which is exactly what
    // `ORDINARY_TRANSACTION_KINDS` and the adjustment policies exist to
    // prevent.
    const action = filesWithCode.find(
      ({ repoPath }) => repoPath === "lib/actions/reconciliation.ts"
    );
    expect(action).toBeDefined();

    for (const field of ["kind", "categoryId", "movementId", "amount"]) {
      expect(action!.code).not.toMatch(new RegExp(`formData\\.get\\(["'\`]${field}["'\`]\\)`));
    }
  });
});
