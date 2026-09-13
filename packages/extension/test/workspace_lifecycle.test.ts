// amicode#1062 — amicode_workspace lifecycle management tool.
//
// Tests the list/remove/reset actions: readable output, parameter validation,
// error translation, and engine-client refusal (matching amicode_session's
// pattern).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-1062-"));

import type { AmicodeToolContext } from "../src/amicode_tools_core";
const CORE = await import("../src/amicode_tools_core");

function makeMockEngine(opts?: {
  /** Override the worktree list result */
  worktrees?: Array<{ directory: string; branch?: string }>;
  /** Make remove throw for a specific directory */
  removeFails?: string;
  /** Make reset throw */
  resetFails?: boolean;
  /** Omit worktree entirely (feature gate off) */
  noWorktree?: boolean;
}) {
  const calls = { list: 0, remove: 0, reset: 0 };
  const worktrees = opts?.worktrees ?? [
    { directory: "/tmp/wt1", branch: "opencode/slice-a" },
    { directory: "/tmp/wt2", branch: "opencode/slice-b" },
    { directory: "/tmp/wt3", branch: "opencode/slice-c" },
  ];
  const engine: Record<string, unknown> = {
    session: {
      get: async () => ({ id: "ses_parent", metadata: undefined, model: undefined }),
      create: async () => ({ id: "ses_child_1" }),
      update: async () => ({}),
      fork: async () => ({ id: "ses_fork_1" }),
      promptAsync: async () => ({}),
      command: async () => ({}),
    },
  };
  if (!opts?.noWorktree) {
    engine.worktree = {
      create: async () => ({ data: { directory: "/tmp/wt-new" } }),
      list: async () => {
        calls.list++;
        return worktrees;
      },
      remove: async (o: any) => {
        calls.remove++;
        const dir = o?.directory ?? o?.body?.directory;
        if (opts?.removeFails === dir) throw new Error("worktree not found");
        if (!worktrees.find((w) => w.directory === dir))
          throw new Error("worktree not found");
        return {};
      },
      reset: async (_o: any) => {
        calls.reset++;
        if (opts?.resetFails) throw new Error("reset failed: uncommitted changes");
        return {};
      },
    };
  }
  return { engine, calls };
}

const def = () =>
  CORE.AMICODE_TOOLS["amicode_workspace"] as (typeof CORE.AMICODE_TOOLS)["amicode_workspace"];

// ── list ─────────────────────────────────────────────────────────────────────

describe("amicode_workspace: list action (#1062)", () => {
  it("returns readable output with count and directories for populated worktrees", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute({ action: "list" }, ctx);
    expect(calls.list).toBe(1);
    expect(result).toContain("3 active worktrees");
    expect(result).toContain("/tmp/wt1");
    expect(result).toContain("/tmp/wt2");
    expect(result).toContain("/tmp/wt3");
    expect(result).toContain("opencode/slice-a");
  });

  it("returns 'No active worktrees' when the list is empty", async () => {
    const { engine } = makeMockEngine({ worktrees: [] });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute({ action: "list" }, ctx);
    expect(result).toContain("No active worktrees");
  });
});

// ── remove ───────────────────────────────────────────────────────────────────

describe("amicode_workspace: remove action (#1062)", () => {
  it("calls remove and returns confirmation for a valid directory", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { action: "remove", directory: "/tmp/wt1" },
      ctx,
    );
    expect(calls.remove).toBe(1);
    expect(result).toContain("Removed worktree");
    expect(result).toContain("/tmp/wt1");
  });

  it("translates 'worktree not found' into an actionable message", async () => {
    const { engine } = makeMockEngine({ removeFails: "/tmp/nonexistent" });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { action: "remove", directory: "/tmp/nonexistent" },
      ctx,
    );
    expect(result).toMatch(/not found|No worktree found/i);
  });

  it("returns validation error when directory is missing", async () => {
    const { engine } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute({ action: "remove" }, ctx);
    expect(result).toMatch(/directory.*required/i);
  });
});

// ── reset ────────────────────────────────────────────────────────────────────

describe("amicode_workspace: reset action (#1062)", () => {
  it("calls reset and returns confirmation for a valid directory", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { action: "reset", directory: "/tmp/wt1" },
      ctx,
    );
    expect(calls.reset).toBe(1);
    expect(result).toContain("Reset worktree");
    expect(result).toContain("/tmp/wt1");
  });

  it("translates API rejection into an error message", async () => {
    const { engine } = makeMockEngine({ resetFails: true });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { action: "reset", directory: "/tmp/wt1" },
      ctx,
    );
    expect(result).toMatch(/reset failed|uncommitted/i);
  });
});

// ── engine-client refusal ────────────────────────────────────────────────────

describe("amicode_workspace: engine-client refusal (#1062)", () => {
  it("refuses all actions when engine client is absent (MCP transport)", async () => {
    const ctx: AmicodeToolContext = { carrier: "mcp" };
    for (const action of ["list", "remove", "reset"]) {
      const result = await def().execute({ action, directory: "/tmp/wt1" }, ctx);
      expect(result, `action=${action}`).toMatch(/Cannot manage workspaces/);
    }
  });

  it("refuses when engine client is present but worktree API is absent (feature gate off)", async () => {
    const { engine } = makeMockEngine({ noWorktree: true });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute({ action: "list" }, ctx);
    expect(result).toMatch(/experimental worktrees feature/i);
  });
});

// ── invalid action ───────────────────────────────────────────────────────────

describe("amicode_workspace: invalid action (#1062)", () => {
  it("returns an error for an unknown action", async () => {
    const { engine } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute({ action: "create" }, ctx);
    expect(result).toMatch(/unknown action|invalid action/i);
  });
});
