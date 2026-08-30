import { defineConfig } from "vitest/config";
import path from "node:path";

// The Phase 7 CP2 mutation suite: real writes, against a real local
// Supabase stack, as a real authenticated owner.
//
// A third config rather than a project inside vitest.config.ts, for the same
// reason vitest.parity.config.ts is separate: `npm test` must stay offline and
// must never require Docker. This one is heavier still than the parity suite —
// its global setup *rebuilds* the local database — so it is only ever invoked
// by `npm run test:mutations`.
//
// Same `server-only` alias as the other two configs: every lib/data/** module
// under test starts with `import "server-only"`, whose default export throws
// under plain Node without the package's react-server-condition empty export.
const serverOnlyEmpty = path.join(
  path.dirname(require.resolve("server-only")),
  "empty.js"
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/mutations/**/*.test.ts"],
    // One database rebuild and one password sign-in per run. See
    // tests/mutations/support/global-setup.ts.
    globalSetup: ["tests/mutations/support/global-setup.ts"],
    // Serial, deliberately and non-negotiably. These tests *write* to one
    // shared database as one owner: two files running concurrently would see
    // each other's rows, and a failure would be a race rather than a defect.
    // `fileParallelism: false` runs files one at a time; Vitest already runs
    // the tests within a file sequentially unless they are marked concurrent.
    fileParallelism: false,
    // Real HTTP against PostgREST, and a global setup that runs `supabase db
    // reset` plus an Auth Admin round-trip.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": serverOnlyEmpty,
    },
  },
});
