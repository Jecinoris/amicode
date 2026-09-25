// `amicode` — doctor, config, env, auth, and the foreground TUI. No vscode import.
import { homedir } from "node:os";
import { checkAssets, formatReport, packageDir, reportOk, resolveAssetRoot } from "./assets.js";
import { runtimeReport } from "./doctor.js";
import { CliSettingsError, cliSettingsPath, readCliSettings, type CliSettings } from "./settings.js";

const USAGE =
  "usage: amicode doctor\n       amicode config\n       amicode env\n       amicode auth\n       amicode auth harmoniqs [--key <api-key>]\n";

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
    const home = env.HOME?.trim() || homedir();
    let settings: CliSettings = {};
    try {
      settings = readCliSettings(cliSettingsPath(home));
    } catch (e) {
      if (!(e instanceof CliSettingsError)) throw e;
    }
    return {
      code: reportOk(report) ? 0 : 1,
      stdout: formatReport(report) + runtimeReport({ home, env, settings }),
      stderr: "",
    };
  }
  if (command === "auth") {
    if (argv[1] === "harmoniqs") {
      let rest = argv.slice(2);
      let keyFromFlag: string | undefined;
      if (rest[0] === "--key") {
        if (rest[1] === undefined) {
          return { code: 64, stdout: "", stderr: `amicode: --key requires a value\n${USAGE}` };
        }
        keyFromFlag = rest[1];
        rest = rest.slice(2);
      }
      if (rest[0] !== undefined) {
        return { code: 64, stdout: "", stderr: `amicode: unexpected argument ${JSON.stringify(rest[0])}\n${USAGE}` };
      }
      return launchHarmoniqsAuth(env, keyFromFlag);
    }
    if (argv[1] !== undefined) {
      return { code: 64, stdout: "", stderr: `amicode: unknown auth target ${JSON.stringify(argv[1])}\n${USAGE}` };
    }
    return launchAuth(env, cwd);
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

/** Key precedence: --key flag, then AMICODE_HARMONIQS_API_KEY, then an
 *  interactive (or piped-line) prompt. --key is convenient for one-off manual
 *  runs but — like any secret passed as a CLI argument — is visible to other
 *  processes on the same machine via the process list; prefer the env var for
 *  scripted/automated provisioning (see remote-install.sh). */
async function launchHarmoniqsAuth(
  env: NodeJS.ProcessEnv,
  keyFromFlag?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { harmoniqsPaths, promptApiKey, writeHarmoniqsAuth } = await import("./harmoniqs_auth.js");
  const home = env.HOME?.trim() || homedir();
  const paths = harmoniqsPaths(home, env);
  const fromFlag = keyFromFlag?.trim() ?? "";
  const fromEnv = env.AMICODE_HARMONIQS_API_KEY?.trim() ?? "";
  const apiKey = fromFlag !== "" ? fromFlag : fromEnv !== "" ? fromEnv : await promptApiKey();
  try {
    writeHarmoniqsAuth({ apiKey, ...paths });
  } catch (e) {
    return { code: 64, stdout: "", stderr: `${e instanceof Error ? e.message : String(e)}\n` };
  }
  return {
    code: 0,
    stdout: `harmoniqs provider written to ${paths.configPath}\ncredential stored in ${paths.authPath}\n`,
    stderr: "",
  };
}

async function launchAuth(env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
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
  const code = await launchOpencode({ binary, cwd, env, args: ["auth", "login"] });
  return { code, stdout: "", stderr: "" };
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
    const { chooseServer, configHash, handshakeFile } = await import("./attach.js");
    const choice = chooseServer(handshakeFile(home), configHash(spawnEnv.OPENCODE_CONFIG_CONTENT));
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
