// `amicode` — round 1 is `doctor` only. Later rounds attach config, env, and
// the TUI to this same entry. No vscode import.
import { checkAssets, formatReport, packageDir, reportOk, resolveAssetRoot } from "./assets.js";

const USAGE = "usage: amicode doctor\n";

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): { code: number; stdout: string; stderr: string } {
  const command = argv[0];
  if (command === undefined) {
    return { code: 64, stdout: "", stderr: USAGE };
  }
  if (command !== "doctor") {
    return { code: 64, stdout: "", stderr: `amicode: unknown command ${JSON.stringify(command)}\n${USAGE}` };
  }
  const root = resolveAssetRoot(env, packageDir());
  const report = checkAssets(root);
  return { code: reportOk(report) ? 0 : 1, stdout: formatReport(report), stderr: "" };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/amicode.js") || entry.endsWith("/cli.ts") || entry.endsWith("/cli.js");
}

if (isMain()) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
