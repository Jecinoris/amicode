// ============================================================================
// #1049 F-harness — the deterministic mid-commit kill hook (spec-20260913
// -114814 §8, fixture F2). The kill is a NAMED STATE-MACHINE BOUNDARY, never a
// signal race: the component under test invokes the registry at its named
// boundaries ("pre-commit", "mid-commit", ...) and the scenario arms one fault
// at exactly one of them — stop (halt at the point), throw (propagate an
// error), or crash (simulate process death, escaping the machine entirely).
//
// JournalingCommitter is the representative consumer (as Lease is for the
// clock): stage → verify → commit { write journal → mark committed }, hooks at
// "pre-commit" (after verify, before the journal) and "mid-commit" (after the
// journal, before the commit is marked done). Its resume() replays the
// journal — F2's restored-or-journaled, never torn.
// ============================================================================

export type KillFaultKind = "stop" | "throw" | "crash";

export type KillFault = { kind: KillFaultKind; error?: Error };

export type KillEvent = { point: string; kind: KillFaultKind };

export class SimulatedCrash extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`simulated crash at "${point}"`);
    this.name = "SimulatedCrash";
    this.point = point;
  }
}

export class KillHookRegistry {
  private readonly armed = new Map<string, KillFault>();
  /** Every fault that actually FIRED, in firing order — the assertion surface. */
  readonly fired: KillEvent[] = [];

  arm(point: string, fault: KillFault): void {
    this.armed.set(point, fault);
  }

  disarm(point: string): void {
    this.armed.delete(point);
  }

  /**
   * Fire whatever is armed at the named point. Unarmed → undefined (no-op).
   * "stop" → returns the event for the machine to obey by halting there;
   * "throw" → throws the armed error; "crash" → throws a SimulatedCrash.
   */
  invoke(point: string): KillEvent | undefined {
    const fault = this.armed.get(point);
    if (!fault) return undefined;
    const event: KillEvent = { point, kind: fault.kind };
    this.fired.push(event);
    if (fault.kind === "throw") throw fault.error ?? new Error(`kill hook fired at "${point}"`);
    if (fault.kind === "crash") throw new SimulatedCrash(point);
    return event;
  }
}

export type CommitStage = "idle" | "staged" | "verified" | "committing" | "committed";

export type CommitJournal = { marker: "commit-pending" };

/**
 * The representative commit state machine the kill hook is proved against:
 * a stop at "pre-commit" leaves it AT verified (no journal, nothing written),
 * a stop/crash at "mid-commit" leaves it journaled-but-uncommitted, and
 * resume() replays the journal to committed — never torn.
 */
export class JournalingCommitter {
  private state: CommitStage = "idle";
  private halted: string | null = null;
  private journalValue: CommitJournal | null = null;
  private committedFlag = false;
  private recovered = false;
  private lastErrorValue: Error | null = null;
  readonly trace: string[] = [];

  constructor(private readonly hooks: KillHookRegistry) {}

  stage_(): CommitStage {
    return this.state;
  }

  get haltedAt(): string | null {
    return this.halted;
  }

  get journal(): CommitJournal | null {
    return this.journalValue;
  }

  get committed(): boolean {
    return this.committedFlag;
  }

  get recoveredFromJournal(): boolean {
    return this.recovered;
  }

  get lastError(): Error | null {
    return this.lastErrorValue;
  }

  stage(): void {
    if (this.state !== "idle") throw new Error(`stage() from state "${this.state}"`);
    this.state = "staged";
    this.trace.push("stage");
  }

  verify(): void {
    if (this.state !== "staged") throw new Error(`verify() from state "${this.state}"`);
    this.state = "verified";
    this.trace.push("verify");
  }

  commit(): void {
    if (this.state !== "verified") throw new Error(`commit() from state "${this.state}"`);
    // named boundary: pre-commit — after verify, before anything is written
    const pre = this.fire("pre-commit");
    if (pre) {
      this.halted = "pre-commit";
      this.trace.push("halt@pre-commit");
      return;
    }
    this.journalValue = { marker: "commit-pending" };
    this.state = "committing";
    this.trace.push("commit:journal");
    // named boundary: mid-commit — journal written, commit not yet marked done
    const mid = this.fire("mid-commit");
    if (mid) {
      this.halted = "mid-commit";
      this.trace.push("halt@mid-commit");
      return;
    }
    this.committedFlag = true;
    this.state = "committed";
    this.trace.push("commit:done");
  }

  /** Recovery: replay the journal (restored-or-journaled), or re-run an aborted pre-commit halt. */
  resume(): void {
    if (this.journalValue && !this.committedFlag) {
      this.recovered = true;
      this.committedFlag = true;
      this.state = "committed";
      this.trace.push("resume:replay", "commit:done");
      return;
    }
    if (this.halted === "pre-commit" && this.state === "verified") {
      this.halted = null;
      this.trace.push("resume:abort-retry");
      this.commit();
    }
  }

  private fire(point: string): KillEvent | undefined {
    try {
      return this.hooks.invoke(point);
    } catch (err) {
      this.lastErrorValue = err as Error;
      throw err;
    }
  }
}
