/**
 * Shared exec types for the rebuild deployment path.
 *
 * Relocated here (#1117) from the retired main-source resolver so the live
 * dependency resolver and the deployment coordinator can share the exec
 * function signature without depending on the removed main-rebuild module.
 */

export interface ExecResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

export type ExecFn = (cmd: string, cwd?: string) => Promise<ExecResult>;
