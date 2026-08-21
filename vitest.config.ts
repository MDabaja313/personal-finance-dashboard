import { defineConfig } from "vitest/config";
import path from "node:path";

// `server-only` is a marker package whose default export throws ("This module
// cannot be imported from a Client Component module..."), by design, so that
// accidentally importing it from client code fails loudly. Under Vitest's
// node environment that same default export resolves — there is no bundler
// applying the package's `react-server` condition — so every lib/data/**
// module (which all start with `import "server-only"`) is unimportable in
// tests without this alias. Swapping in the package's own empty.js (the file
// it exports under the `react-server` condition) is test-config only: the
// production `import "server-only"` statements are untouched, and no
// production module is created. Resolved via `require.resolve` rather than a
// hardcoded path so it stays correct regardless of hoisting layout or OS path
// separators; safe here because this config file loads as CommonJS (see
// `__dirname` above), so `require` is available without an import.
const serverOnlyEmpty = path.join(
  path.dirname(require.resolve("server-only")),
  "empty.js"
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": serverOnlyEmpty,
    },
  },
});
