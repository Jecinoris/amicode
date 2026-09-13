// amicode#1060 — workspace isolation for amicode_session.
//
// Tests the handler-level workspace logic: worktree creation, timeout,
// compensating cleanup, path validation, feature gate, and the soft
// warning at 5+ worktrees.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-1060-"));

import type { AmicodeToolContext } from "../src/amicode_tools_core";
const CORE = await import("../src/amicode_tools_core");

afterEach(() => {
  vi.restoreAllMocks();
});

function makeMockEngine(opts?: {
  /** worktree.create return value (or a function to call) */
  worktreeCreate?: () => Promise<unknown>;
  /** worktree.list return value */
  worktreeList?: unknown[];
  /** worktree.remove mock */
  worktreeRemove?: () => Promise<unknown>;
  /** Omit worktree entirely (feature gate off) */
  noWorktree?: boolean;
}) {
  const calls = {
    create: 0,
    fork: 0,
    prompt: 0,
    worktreeCreate: 0,
    worktreeList: 0,
    worktreeRemove: 0,
  };
  const engine: Record<string, unknown> = {
    session: {
      get: async () => ({ id: "ses_parent", metadata: undefined, model: undefined }),
      create: async () => {
        calls.create += 1;
        return { id: `ses_child_${calls.create}` };
      },
      update: async () => ({}),
      fork: async () => {
        calls.fork += 1;
        return { id: `ses_fork_${calls.fork}` };
      },
      promptAsync: async () => {
        calls.prompt += 1;
        return {};
      },
      command: async () => ({}),
    },
  };
  if (!opts?.noWorktree) {
    engine.worktree = {
      create: opts?.worktreeCreate ??
        (async () => {
          calls.worktreeCreate += 1;
          return { data: { directory: `/tmp/worktree-${calls.worktreeCreate}` } };
        }),
      list: async () => {
        calls.worktreeList += 1;
        return { data: opts?.worktreeList ?? [] };
      },
      remove: opts?.worktreeRemove ??
        (async () => {
          calls.worktreeRemove += 1;
          return {};
        }),
    };
  }
  return { engine, calls };
}

const def = () =>
  CORE.AMICODE_TOOLS["amicode_session"] as (typeof CORE.AMICODE_TOOLS)["amicode_session"];

describe("workspace: \"create\" — worktree provisioning (#1060)", () => {
  it("calls worktree.create and scopes the child session to the returned directory", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "implement feature X", workspace: "create" },
      ctx,
    );
    expect(calls.worktreeCreate).toBe(1);
    expect(calls.create).toBe(1);
    expect(result).toContain("Spawned 1");
    expect(result).toContain("ses_child_1");
  });

  it("times out after 30 seconds and calls compensating delete", async () => {
    const removeCalls: number[] = [];
    const { engine } = makeMockEngine({
      worktreeCreate: () => new Promise(() => {}), // never resolves
      worktreeRemove: async () => { removeCalls.push(1); return {}; },
    });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };

    // Speed up the test by faking the 30s timer.
    vi.useFakeTimers();
    const promise = def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    // advanceTimersByTimeAsync properly drains microtasks between
    // timer ticks so the handler reaches the Promise.race before we fire.
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;
    vi.useRealTimers();

    const parsed = JSON.parse(result);
    expect(parsed.reason).toBe("timeout");
    expect(parsed.error).toContain("timed out");
    expect(removeCalls.length).toBe(1); // compensating delete attempted
  });

  it("calls compensating worktree delete when session creation fails", async () => {
    const removeCalls: number[] = [];
    let createCount = 0;
    const { engine } = makeMockEngine({
      worktreeCreate: async () => {
        createCount += 1;
        return { data: { directory: `/tmp/wt-${createCount}` } };
      },
      worktreeRemove: async () => { removeCalls.push(1); return {}; },
    });
    // Override session.create to fail
    (engine.session as any).create = async () => { throw new Error("session boom"); };
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.reason).toBe("session_failed");
    expect(parsed.error).toContain("session boom");
    expect(removeCalls.length).toBe(1); // compensating delete attempted
  });

  it("returns actionable error when feature gate is off (no worktree API)", async () => {
    const { engine } = makeMockEngine({ noWorktree: true });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    expect(result).toContain("experimental worktrees feature");
  });

  it("translates API feature-gate rejection into actionable error", async () => {
    const { engine } = makeMockEngine({
      worktreeCreate: async () => { throw new Error("worktree feature not enabled"); },
    });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.reason).toBe("api_rejected");
    expect(parsed.error).toContain("experimental worktrees feature");
  });
});

describe("workspace: \"<path>\" — reuse existing worktree (#1060)", () => {
  it("accepts a valid git worktree path", async () => {
    // Create a fake worktree directory with a .git file
    const wtDir = mkdtempSync(join(tmpdir(), "amicode-wt-valid-"));
    writeFileSync(join(wtDir, ".git"), "gitdir: /project/.git/worktrees/wt-1\n");

    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: wtDir },
      ctx,
    );
    expect(calls.create).toBe(1);
    expect(result).toContain("Spawned 1");
  });

  it("rejects a path that is not a git worktree", async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "amicode-wt-invalid-"));
    // No .git file at all
    const { engine } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: fakeDir },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.reason).toBe("validation_failed");
    expect(parsed.error).toContain("not a valid git worktree");
  });

  it("rejects a full git repo (has .git directory, not file)", async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "amicode-wt-repo-"));
    mkdirSync(join(fakeDir, ".git")); // directory, not file
    const { engine } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: fakeDir },
      ctx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.reason).toBe("validation_failed");
    expect(parsed.error).toContain("full git repository");
  });
});

describe("workspace: null — unchanged behavior (#1060)", () => {
  it("inherits the parent directory when workspace is null", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: null },
      ctx,
    );
    expect(calls.create).toBe(1);
    expect(calls.worktreeCreate).toBe(0); // no worktree created
    expect(result).toContain("Spawned 1");
  });

  it("inherits the parent directory when workspace is omitted", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x" },
      ctx,
    );
    expect(calls.create).toBe(1);
    expect(calls.worktreeCreate).toBe(0);
    expect(result).toContain("Spawned 1");
  });
});

describe("soft warning at 5+ worktrees (#1060)", () => {
  it("includes a warning when 5+ worktrees exist", async () => {
    const fiveWorktrees = Array.from({ length: 6 }, (_, i) => ({ directory: `/wt-${i}` }));
    const { engine } = makeMockEngine({ worktreeList: fiveWorktrees });
    // Use "create" to trigger the worktree code path
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    expect(result).toContain("6 active worktrees");
    expect(result).toContain("Spawned 1"); // still spawns — warning doesn't block
  });

  it("no warning when fewer than 5 worktrees", async () => {
    const threeWorktrees = Array.from({ length: 3 }, (_, i) => ({ directory: `/wt-${i}` }));
    const { engine } = makeMockEngine({ worktreeList: threeWorktrees });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    expect(result).not.toContain("active worktrees");
    expect(result).toContain("Spawned 1");
  });
});

describe("fail-hard behavior (#1060 AC9)", () => {
  it("never silently falls back to parent directory on worktree error", async () => {
    const { engine } = makeMockEngine({
      worktreeCreate: async () => { throw new Error("disk full"); },
    });
    const ctx: AmicodeToolContext = {
      engineClient: engine as any,
      sessionID: "ses_parent",
      directory: "/project",
      carrier: "plugin",
    };
    const result = await def().execute(
      { prompt: "x", workspace: "create" },
      ctx,
    );
    // Must be an error, NOT a successful spawn in the parent directory
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.reason).toBe("api_rejected");
    // Must NOT contain "Spawned" — no silent fallback
    expect(result).not.toContain("Spawned");
  });
});
