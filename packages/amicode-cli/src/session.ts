// Round 2: assemble the same opencode session config the extension builds,
// from the asset root and the current directory. No vscode import.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readSolverModeState } from "../../extension/src/solver_mode.js";
import {
  buildOpencodeConfigContent,
  prepareOpencodeProject,
  resolveJuliaProject,
} from "../../extension/src/opencode_config.js";
import { cliSettingsPath, projectDirForCwd, readCliSettings, type CliSettings } from "./settings.js";

/** Build the OPENCODE_CONFIG_CONTENT JSON for `cwd`. `home` is where the
 *  project dir and the default Julia project live. Settings default to
 *  ~/.amico/cli.json under that home. */
export function buildSessionConfig(opts: {
  assetRoot: string;
  cwd: string;
  home?: string;
  settings?: CliSettings;
}): string {
  const home = opts.home ?? homedir();
  const settings = opts.settings ?? readCliSettings(cliSettingsPath(home));
  const templateName = readSolverModeState().mode === "hp" ? "solve_template_hp.jl" : "solve_template.jl";
  const project = prepareOpencodeProject({
    agentsSrc: join(opts.assetRoot, "AGENTS.md"),
    templateSrc: join(opts.assetRoot, "templates", templateName),
    juliaProject: resolveJuliaProject(settings.juliaProject ?? ""),
    scoresRoot: join(opts.assetRoot, "scores"),
    packsRoot: join(opts.assetRoot, "packs"),
    skillRoots: settings.skillRoots,
    skillLibraryRoots: [
      { path: join(opts.assetRoot, "skills"), surfaces: ["public", "entitled"] },
      { path: join(home, ".amico", "vaults", "armonissima", "skills"), surfaces: ["internal"] },
    ],
    vaultDir: settings.vaultDir,
    workspaceFolders: [resolve(opts.cwd)],
    projectDir: projectDirForCwd(opts.cwd, home),
  });
  return buildOpencodeConfigContent(
    project.agentsPath,
    project.templatePath,
    join(home, ".amico", "runs", "default"),
    undefined,
    join(opts.assetRoot, "scores"),
    project.skillPaths,
    project.skillsStageDir,
    project.vaultDir,
    project.mounts,
    settings.defaultModel,
    false,
    [join(opts.assetRoot, "opencode-plugin", "amicode_context.ts")],
    join(opts.assetRoot, "bin", "dist", "mcp-amico.mjs"),
  );
}
