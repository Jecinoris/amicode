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
  },
});
