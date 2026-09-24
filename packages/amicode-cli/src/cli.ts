// `amicode` — doctor, config, env, and the foreground TUI. No vscode import.
import { homedir } from "node:os";
import { checkAssets, formatReport, packageDir, reportOk, resolveAssetRoot } from "./assets.js";
import { CliSettingsError, cliSettingsPath, readCliSettings, type CliSettings } from "./settings.js";

const USAGE = "usage: amicode doctor\n       amicode config\n       amicode env\n";

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = argv[0];
  if (command === undefined) {
    return launchTui(env, cwd);
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
  if (command === "env") {
    try {
      const home = env.HOME?.trim() || homedir();
      const settings = readCliSettings(cliSettingsPath(home));
      const { listing } = await describeSpawnEnv({
        assetRoot: resolveAssetRoot(env, packageDir()),
        cwd,
        home,
        settings,
        env,
      });
      return { code: 0, stdout: listing, stderr: "" };
    } catch (e) {
      if (e instanceof CliSettingsError) return { code: 64, stdout: "", stderr: `${e.message}\n` };
      throw e;
    }
  }
  return { code: 64, stdout: "", stderr: `amicode: unknown command ${JSON.stringify(command)}\n${USAGE}` };
}

async function launchTui(env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const assetRoot = resolveAssetRoot(env, packageDir());
  const { binaryReady, launchOpencode, vendoredOpencodeBinary } = await import("./launch.js");
  const binary = vendoredOpencodeBinary(assetRoot);
  if (!binaryReady(binary)) {
    return {
      code: 1,
      stdout: "",
      stderr: `amicode: vendored opencode missing or not executable (${binary})\nrun amicode doctor\n`,
    };
  }
  try {
    const home = env.HOME?.trim() || homedir();
    const settings = readCliSettings(cliSettingsPath(home));
    const { env: spawnEnv } = await describeSpawnEnv({
      assetRoot,
      cwd,
      home,
      settings,
      env,
    });
    const { chooseServer, configHash, conflictMessage, handshakeFile } = await import("./attach.js");
    const choice = chooseServer(handshakeFile(home), configHash(spawnEnv.OPENCODE_CONFIG_CONTENT));
    if (choice.action === "conflict") {
      return { code: 1, stdout: "", stderr: conflictMessage(choice.port) };
    }
    const code = await launchOpencode({
      binary,
      cwd,
      env:
        choice.action === "attach"
          ? { ...env, ...spawnEnv, OPENCODE_SERVER_PASSWORD: choice.password }
          : { ...env, ...spawnEnv },
      args: choice.action === "attach" ? ["attach", choice.url] : [],
    });
    return { code, stdout: "", stderr: "" };
  } catch (e) {
    if (e instanceof CliSettingsError) return { code: 64, stdout: "", stderr: `${e.message}\n` };
    throw e;
  }
}

/** The spawn env plus the key-only listing `amicode env` prints. */
export async function describeSpawnEnv(opts: {
  assetRoot: string;
  cwd: string;
  home?: string;
  settings?: CliSettings;
  env?: NodeJS.ProcessEnv;
  password?: string;
}): Promise<{ env: Record<string, string>; listing: string }> {
  const { buildCliSpawnEnv, formatEnvKeys } = await import("./spawn.js");
  const spawnEnv = buildCliSpawnEnv(opts);
  return { env: spawnEnv, listing: formatEnvKeys(spawnEnv) };
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
