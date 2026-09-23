import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/amicode.js",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
