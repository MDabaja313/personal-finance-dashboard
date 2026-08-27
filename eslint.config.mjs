import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Architectural boundaries (see CLAUDE.md). `no-restricted-imports` targets
// `@/lib/supabase/**` even though that directory doesn't exist yet — the
// rule is a no-op today and starts enforcing the moment Phase 5 adds it.
const noProcessEnv = {
  "no-restricted-properties": [
    "error",
    {
      object: "process",
      property: "env",
      message:
        "Env access is centralized in lib/supabase/**. Consume a configured client instead of reading process.env directly.",
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      ...noProcessEnv,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/data", "@/lib/data/*"],
              message:
                "components/** must not import the DAL directly. Fetch data in a Server Component at the route level (app/**) and pass it down as props.",
            },
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message: "components/** must never access Supabase directly.",
            },
            {
              group: ["@/lib/mock", "@/lib/mock/*"],
              message:
                "components/** must not import mock fixtures directly. Go through lib/data/**, which reads fixtures during the mock phase.",
            },
          ],
        },
      ],
      // Separate rule, not another pattern above, because this one must allow
      // `import type`. A form needs `ActionState`/`FormAction` at the type
      // level to call useActionState; a type import is erased at compile time
      // and carries no runtime reach. The Server Action itself arrives as a
      // prop — the same arrangement components/auth/login-form.tsx already
      // uses for lib/auth. The base no-restricted-imports rule above cannot
      // express that exemption, which is why the typescript-eslint version is
      // used here; the two rules cover disjoint paths, so nothing
      // double-reports.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/actions", "@/lib/actions/*"],
              allowTypeImports: true,
              message:
                "components/** must not value-import lib/actions/**. Server Actions are passed in as props; import only their types (`import type`).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      ...noProcessEnv,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message:
                "app/** must not import Supabase clients directly. Go through lib/data/** for data, or lib/auth/** for identity and the auth Server Actions.",
            },
            {
              group: ["@/lib/mock", "@/lib/mock/*"],
              message:
                "app/** must not import mock fixtures directly. Go through lib/data/**, which reads fixtures during the mock phase.",
            },
            {
              group: ["@/lib/data/mutations", "@/lib/data/mutations/*"],
              message:
                "app/** must not call mutation DAL functions directly. Go through a Server Action in lib/actions/**, which is where auth, validation, revalidation, and the ActionState contract live.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/data/**/*.{ts,tsx}"],
    rules: noProcessEnv,
  },
  {
    // lib/data/supabase.ts is the single authorized crossing into
    // lib/supabase/** from the DAL — every other lib/data module reaches the
    // database through that seam's `getDataClient()`/`getOwnerId()`. Keeping
    // it to one file is what lets the parity suite mock exactly one module
    // while every mapper, query builder, and ordering chain under test stays
    // real production code. `ignores` exempts that one path, not the
    // directory. `noProcessEnv` above still applies to it: env access stays
    // centralized in lib/supabase/env.ts.
    files: ["lib/data/**/*.{ts,tsx}"],
    ignores: ["lib/data/supabase.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message:
                "Only lib/data/supabase.ts may import lib/supabase/**. Use getDataClient()/getOwnerId() from that seam instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // lib/data/mutations/** — the write half of the DAL (Phase 7 CP2 onward).
    // This block comes *after* the two lib/data blocks above deliberately:
    // flat config replaces a rule wholesale rather than merging it, so the
    // supabase pattern is restated here rather than inherited.
    //
    // The navigation/cache ban is the load-bearing half. `lib/actions/**`
    // wraps every mutation in `attempt()`, which catches everything — and
    // Next.js signals redirect()/notFound() by *throwing*. A redirect issued
    // from inside the mutation would therefore be swallowed and reported as a
    // generic failure while the navigation silently never happened.
    // lib/actions/result.ts refuses to paper over that by sniffing NEXT_*
    // digests; this rule is what makes the situation unreachable instead.
    files: ["lib/data/mutations/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message:
                "Only lib/data/supabase.ts may import lib/supabase/**. Use getDataClient()/getOwnerId() from that seam instead.",
            },
            {
              group: ["next/navigation", "next/navigation/*"],
              message:
                "lib/data/mutations/** must not navigate. redirect()/notFound() throw, and the action layer's attempt() would swallow that throw. Return to lib/actions/** and navigate there.",
            },
            {
              group: ["next/cache", "next/cache/*"],
              message:
                "lib/data/mutations/** must not revalidate. Cache invalidation is the Server Action's decision, in lib/actions/**, after the write returns.",
            },
          ],
        },
      ],
    },
  },
  {
    // lib/actions/** — the Server Action layer: auth re-verification,
    // validation, the mutation call, then navigation/revalidation. It reaches
    // the database only through lib/data/**, never by constructing a client
    // of its own.
    files: ["lib/actions/**/*.{ts,tsx}"],
    rules: {
      ...noProcessEnv,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message:
                "lib/actions/** must not import Supabase clients. Go through lib/data/** for data and lib/auth/** for identity.",
            },
            {
              group: ["@/lib/mock", "@/lib/mock/*"],
              message: "lib/actions/** must not import mock fixtures.",
            },
          ],
        },
      ],
    },
  },
  {
    // lib/validation/** — untrusted input → domain values, and nothing else.
    // Pure for the same reasons lib/finance/** is: a validator that read the
    // clock could not be tested at a fixed date and would disagree with the
    // owner's timezone-derived calendar day, and one that could reach a client
    // would blur where input stops being untrusted.
    files: ["lib/validation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/data", "@/lib/data/*"],
              message:
                "lib/validation/** must stay pure — no DAL access. Take what it needs (`today`, an owned-id list) as parameters instead.",
            },
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message: "lib/validation/** must stay pure — no Supabase access.",
            },
            {
              group: ["@/lib/mock", "@/lib/mock/*"],
              message: "lib/validation/** must stay pure — no fixture access.",
            },
            {
              group: ["react", "react-dom"],
              message:
                "lib/validation/** must stay pure — no React. These are plain schemas and parsers.",
            },
            {
              group: ["next", "next/*"],
              message:
                "lib/validation/** must stay pure — no Next.js. No headers, no cache, no navigation.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        ...noProcessEnv["no-restricted-properties"],
        {
          object: "Date",
          property: "now",
          message:
            "lib/validation/** must not read the clock — accept `today` as an explicit parameter instead (see zNotFuture).",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "lib/validation/** must not read the clock — accept `today` as an explicit parameter instead of `new Date()`.",
        },
      ],
    },
  },
  {
    files: ["lib/finance/**/*.{ts,tsx}"],
    rules: {
      ...noProcessEnv,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/data", "@/lib/data/*"],
              message:
                "lib/finance/** must stay pure — no DAL access. Take the data it needs as parameters instead.",
            },
            {
              group: ["@/lib/mock", "@/lib/mock/*"],
              message:
                "lib/finance/** must stay pure — no fixture access. Take the data it needs as parameters instead.",
            },
            {
              group: ["@/lib/supabase", "@/lib/supabase/*"],
              message: "lib/finance/** must stay pure — no Supabase access.",
            },
            {
              group: ["react", "react-dom"],
              message: "lib/finance/** must stay pure — no React. These are plain calculation functions.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        ...noProcessEnv["no-restricted-properties"],
        {
          object: "Date",
          property: "now",
          message:
            "lib/finance/** must not read the clock — accept `today` as an explicit parameter instead.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "lib/finance/** must not read the clock — accept `today` as an explicit parameter instead of `new Date()`.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated, gitignored Supabase CLI local state (containers write
    // vendored/bundled code here, e.g. an edge-runtime Deno bundle) —
    // not project source, never committed. Scoped narrowly so committed
    // files under supabase/** (migrations, config.toml, tests) stay
    // visible to normal tooling and review.
    "supabase/.temp/**",
    "supabase/.branches/**",
  ]),
]);

export default eslintConfig;
