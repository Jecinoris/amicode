// `amicode` — doctor (round 1) and config (round 2). Later rounds attach the
// process environment and the TUI to this same entry. No vscode import.
import { homedir } from "node:os";
import { checkAssets, formatReport, packageDir, reportOk, resolveAssetRoot } from "./assets.js";
import { CliSettingsError, cliSettingsPath, readCliSettings } from "./settings.js";

const USAGE = "usage: amicode doctor\n       amicode config\n";

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = argv[0];
  if (command === undefined) {
    return { code: 64, stdout: "", stderr: USAGE };
  }
  if (command === "doctor") {
    const root = resolveAssetRoot(env, packageDir());
    const report = checkAssets(root);
    return { code: reportOk(report) ? 0 : 1, stdout: formatReport(report), stderr: "" };
  }
  if (command === "config") {
    try {
      const home = env.HOME?.trim() || homedir();
      const settings = readCliSettings(cliSettingsPath(home));
      const { buildSessionConfig } = await import("./session.js");
      const json = buildSessionConfig({
        assetRoot: resolveAssetRoot(env, packageDir()),
        cwd,
        home,
        settings,
      });
      return { code: 0, stdout: `${JSON.stringify(JSON.parse(json), null, 2)}\n`, stderr: "" };
    } catch (e) {
      if (e instanceof CliSettingsError) return { code: 64, stdout: "", stderr: `${e.message}\n` };
      throw e;
    }
  }
  return { code: 64, stdout: "", stderr: `amicode: unknown command ${JSON.stringify(command)}\n${USAGE}` };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/amicode.cjs") || entry.endsWith("/amicode.js") || entry.endsWith("/cli.ts") || entry.endsWith("/cli.js");
}

if (isMain()) {
  run(process.argv.slice(2))
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.code);
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
