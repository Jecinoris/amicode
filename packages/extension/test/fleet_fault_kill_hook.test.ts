import { describe, it, expect } from "vitest";
import {
  KillHookRegistry,
  SimulatedCrash,
  JournalingCommitter,
} from "./fixtures/fleet_fault_harness/kill_hook";

// ============================================================================
// #1049 F-harness — the deterministic mid-commit kill hook (spec-20260913
// -114814 §8, AC3 + fixture F2). The kill is a NAMED STATE-MACHINE BOUNDARY,
// never a signal race: the component under test invokes the registry at its
// named boundaries ("pre-commit", "mid-commit") and the scenario arms a fault
// at exactly one of them. The test proves the target stops AT the named point
// — not nearby — via the machine's own observable state, journal, and trace.
//
// JournalingCommitter is the representative consumer (like Lease is for the
// clock): stage → verify → commit { write journal → mark committed }, with
// hooks at "pre-commit" (after verify, before the journal) and "mid-commit"
// (after the journal, before the commit is marked done). F2's invariant —
// restored-or-journaled, never torn — is what resume() replays from.
// ============================================================================

describe("KillHookRegistry — named-point fault injection", () => {
  it("is a no-op at a point nothing armed (the machine runs straight through)", () => {
    const hooks = new KillHookRegistry();
    const machine = new JournalingCommitter(hooks);
    machine.stage();
    machine.verify();
    machine.commit();
    expect(machine.stage_()).toBe("committed");
    expect(hooks.fired).toEqual([]);
  });

  it("arming pre-commit fires ONLY pre-commit (named-point specificity)", () => {
    const hooks = new KillHookRegistry();
    hooks.arm("pre-commit", { kind: "stop" });
    const machine = new JournalingCommitter(hooks);
    machine.stage();
    machine.verify();
    try {
      machine.commit();
    } catch {
      // a stop is reported, not thrown — reaching here would be a bug
      throw new Error("stop faults must not throw");
    }
    expect(hooks.fired).toEqual([{ point: "pre-commit", kind: "stop" }]);
  });

  it("throw faults propagate the given error into the machine's caller", () => {
    const hooks = new KillHookRegistry();
    const boom = new Error("verify infra flaked");
    hooks.arm("pre-commit", { kind: "throw", error: boom });
    const machine = new JournalingCommitter(hooks);
    machine.stage();
    machine.verify();
    expect(() => machine.commit()).toThrow(boom);
    expect(hooks.fired).toEqual([{ point: "pre-commit", kind: "throw" }]);
    expect(machine.lastError).toBe(boom);
  });
});

describe("KillHook — stop at PRE-COMMIT: the target stops AT the point, not nearby", () => {
  it("verify already ran, the journal was never written, nothing was committed", () => {
    const hooks = new KillHookRegistry();
    hooks.arm("pre-commit", { kind: "stop" });
    const machine = new JournalingCommitter(hooks);
    machine.stage();
    machine.verify();
    machine.commit();

    expect(machine.haltedAt).toBe("pre-commit"); // stopped at THE point
    expect(machine.stage_()).toBe("verified"); // the stage the halt left
    expect(machine.journal).toBeNull(); // pre-journal: the write never began
    expect(machine.committed).toBe(false);
    expect(machine.trace).toEqual(["stage", "verify", "halt@pre-commit"]); // not one step further, not one step earlier
  });
});

describe("KillHook — stop at MID-COMMIT: journaled, then restored — never torn", () => {
  it("the journal exists at the halt and resume() replays it to committed", () => {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "stop" });
    const machine = new JournalingCommitter(hooks);
    machine.stage();
    machine.verify();
    machine.commit();

    expect(machine.haltedAt).toBe("mid-commit");
    expect(machine.stage_()).toBe("committing"); // mid-flight, exactly
    expect(machine.journal).not.toBeNull(); // F2: journaled
    expect(machine.committed).toBe(false);

    machine.resume();
    expect(machine.stage_()).toBe("committed"); // restored-or-journaled
    expect(machine.committed).toBe(true);
    expect(machine.recoveredFromJournal).toBe(true);
  });

  it("a CRASH fault at mid-commit simulates process death and recovery still replays", () => {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "crash" });
    const machine = new JournalingCommitter(hooks);
    machine.stage();
    machine.verify();

    // the crash escapes the machine entirely — the process-death analog
    expect(() => machine.commit()).toThrow(SimulatedCrash);
    expect(hooks.fired).toEqual([{ point: "mid-commit", kind: "crash" }]);
    expect(machine.journal).not.toBeNull();

    machine.resume(); // next process replays the journal
    expect(machine.stage_()).toBe("committed");
    expect(machine.recoveredFromJournal).toBe(true);
  });
});

describe("KillHook — determinism: the scenario reproduces from config", () => {
  it("the same fault scenario twice yields the identical trace", () => {
    const run = () => {
      const hooks = new KillHookRegistry();
      hooks.arm("mid-commit", { kind: "stop" });
      const machine = new JournalingCommitter(hooks);
      machine.stage();
      machine.verify();
      try {
        machine.commit();
      } catch {
        // crash faults throw; stop faults don't — both recorded in the trace
      }
      machine.resume();
      return { trace: machine.trace, fired: hooks.fired };
    };
    const a = run();
    const b = run();
    expect(a.trace).toEqual(b.trace);
    expect(a.fired).toEqual(b.fired);
    expect(a.trace).toEqual(["stage", "verify", "commit:journal", "halt@mid-commit", "resume:replay", "commit:done"]);
  });
});
