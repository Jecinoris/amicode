import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/amicode.cjs",
  // Extension source is outside this package. Its bare imports live in this
  // package's node_modules (and, for @amicode/schema, that package's own).
  nodePaths: [join(here, "node_modules")],
  // The src/ fallback uses import.meta.url. The bundle takes the dist/amicode.cjs
  // branch instead, so the empty import.meta in the cjs output is unused.
  logOverride: { "empty-import-meta": "silent" },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
