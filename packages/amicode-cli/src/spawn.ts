// Round 3: the env the extension passes to `opencode serve`, plus the setup
// snapshot the context plugin reads. Values stay in the returned object.
// `amicode env` prints names only.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mintServerPassword, buildServerSpawnEnv } from "../../extension/src/server_auth.js";
import { resolveJuliaProject } from "../../extension/src/opencode_config.js";
import { computeSetupState, writeSetupStateFile } from "../../extension/src/setup_state.js";
import { resolveAmicoLauncherDir } from "./assets.js";
import { buildSessionConfig } from "./session.js";
import { cliSettingsPath, readCliSettings, type CliSettings } from "./settings.js";

export function formatEnvKeys(env: Record<string, string>): string {
  return `${Object.keys(env).sort().join("\n")}\n`;
}

/** Mint a server password, build the spawn env, and write setup-state.json.
 *  `password` is for tests; a real launch mints one and never prints it. */
export function buildCliSpawnEnv(opts: {
  assetRoot: string;
  cwd: string;
  home?: string;
  settings?: CliSettings;
  env?: NodeJS.ProcessEnv;
  password?: string;
}): Record<string, string> {
  const home = opts.home ?? homedir();
  const settings = opts.settings ?? readCliSettings(cliSettingsPath(home));
  const password = opts.password ?? mintServerPassword();
  const configContent = buildSessionConfig({
    assetRoot: opts.assetRoot,
    cwd: opts.cwd,
    home,
    settings,
  });
  const opsDir = opts.env?.AMICODE_OPS_DIR?.trim() || join(home, ".amico", "amicode");
  writeSetupStateFile(
    computeSetupState({
      extensionPath: opts.assetRoot,
      juliaProject: resolveJuliaProject(settings.juliaProject ?? ""),
      labTomlSetting: "",
    }),
    opsDir,
  );
  return buildServerSpawnEnv({
    amicoRunBinDir: resolveAmicoLauncherDir(opts.assetRoot),
    configContent,
    serverPassword: password,
    env: opts.env,
    workspaceFolders: resolve(opts.cwd),
  });
}
