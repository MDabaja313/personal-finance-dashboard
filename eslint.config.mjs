import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Architectural boundaries (see CLAUDE.md). `no-restricted-imports` targets
// `@/lib/supabase/**` even though that directory doesn't exist yet — the
// rule is a no-op today and starts enforcing the moment Phase 3 adds it.
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
                "app/** must not import Supabase clients directly. Go through lib/data/**.",
            },
            {
              group: ["@/lib/mock", "@/lib/mock/*"],
              message:
                "app/** must not import mock fixtures directly. Go through lib/data/**, which reads fixtures during the mock phase.",
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
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
