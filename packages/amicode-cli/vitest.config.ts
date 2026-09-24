import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    // Point at yaml's Node build. Vitest otherwise loads a virtual "yaml"
    // module whose relative requires resolve against the package root.
    alias: { yaml: require.resolve("yaml") },
    conditions: ["node", "import", "module", "default"],
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/slow/**"],
    // Several tests rebuild dist/amicode.cjs. One file at a time keeps that
    // write from landing under another file's require().
    fileParallelism: false,
  },
});
