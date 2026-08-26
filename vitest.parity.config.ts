import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate config/project from vitest.config.ts, deliberately: `npm test`
// must stay offline and never require Docker/Supabase. This config is only
// ever invoked by `npm run test:parity`, against a running local Supabase
// stack and a login-capable owner (`npm run auth:reset-local`).
//
// Same `server-only` alias as vitest.config.ts, for the same reason — every
// lib/data/** module under test here starts with `import "server-only"`,
// which needs the package's react-server-condition empty export to be
// importable under plain Node.
const serverOnlyEmpty = path.join(
  path.dirname(require.resolve("server-only")),
  "empty.js"
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/parity/**/*.test.ts"],
    // Real network calls (sign-in, PostgREST) against a local Supabase stack
    // are slower than the offline unit suite's defaults.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": serverOnlyEmpty,
    },
  },
});
