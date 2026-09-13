// #1069 (fleet rearchitect P4a-1, ADR-0005 — the mode/posture split): the
// base-owned attach-state schema + the mode machine as its SOLE writer.
//
// The amendment's mechanics, asserted here:
//   · mode (standalone|fleet) and posture (ok|degraded|hub-down) are SEPARATE
//     additive optional fields (mode absent = standalone, posture absent = ok)
//     — the frozen legacy `state` field is PRESERVED, dual-written with its
//     legacy projection, never renamed or removed.
//   · The read side prefers the new fields with a mapping for old values
//     (rearchitect spec §0.2's table: transport-written standalone → posture
//     hub-down; degraded → degraded; fleet → mode fleet + posture ok).
//   · Bidirectional preserve-on-rewrite survives the split: a base rewrite
//     preserves overlay-written fields it does not understand, and an overlay
//     rewrite preserves base-written fields (mode/posture are machine-owned —
//     the 09-13 accidental-mode-exit class dies at the field level).
//   · The posture vocabulary is CLOSED at {ok, degraded, hub-down} —
//     commit-pending is a mode-machine journal state, never a posture value.
//   · Posture writes are render-only and exempt from serialization/journal:
//     the machine's MODE journal exists as a surface, and no posture write
//     ever lands in it.
//   · Structural-class signals (auth-revoked class) are typed events on a
//     small surface — no behavior beyond emission, never an attach-state write.
import { describe, it, expect } from "vitest";
import {
  ATTACH_MODES,
  ATTACH_POSTURES,
  ModeMachine,
  legacyStateOf,
  mergeAttachState,
  resolveAttachState,
  type AttachStateRecord,
} from "../src/amicode_service/attach_state";

// ══════════════════════════════════════════════════════════════════════════════
// The schema — additive fields, closed vocabularies, base defaults
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 attach-state schema — additive mode + posture fields per ADR-0005", () => {
  it("the vocabularies are closed: mode at {standalone, fleet}, posture at {ok, degraded, hub-down} — commit-pending is NOT a posture value", () => {
    expect([...ATTACH_MODES]).toEqual(["standalone", "fleet"]);
    expect([...ATTACH_POSTURES]).toEqual(["ok", "degraded", "hub-down"]);
  });

  it("the base defaults: an empty record reads mode standalone + posture ok", () => {
    expect(resolveAttachState({})).toEqual({ mode: "standalone", posture: "ok" });
  });

  it("the read-side mapping for old values (§0.2's table): frozen fleet → mode fleet + posture ok", () => {
    expect(resolveAttachState({ state: "fleet" })).toEqual({ mode: "fleet", posture: "ok" });
  });

  it("frozen degraded → mode fleet + posture degraded (degraded is fleet-with-a-slow-hub, not a membership change)", () => {
    expect(resolveAttachState({ state: "degraded" })).toEqual({ mode: "fleet", posture: "degraded" });
  });

  it("frozen standalone → posture hub-down (the transport-written hub-down entry — its frozen rendering was base standalone)", () => {
    expect(resolveAttachState({ state: "standalone" })).toEqual({ mode: "standalone", posture: "hub-down" });
  });

  it("readers prefer the new fields: both present, the new pair wins over the legacy field", () => {
    const record: AttachStateRecord = { state: "fleet", mode: "fleet", posture: "degraded" };
    expect(resolveAttachState(record)).toEqual({ mode: "fleet", posture: "degraded" });
  });

  it("the legacy projection (new → old) renders the frozen triple for old readers", () => {
    expect(legacyStateOf("standalone", "ok")).toBe("standalone");
    expect(legacyStateOf("fleet", "ok")).toBe("fleet");
    expect(legacyStateOf("fleet", "degraded")).toBe("degraded");
    // hub-down's frozen rendering IS base standalone — a rendering, never a membership change
    expect(legacyStateOf("fleet", "hub-down")).toBe("standalone");
  });

  it("an invalid new-field value fails safe to the legacy mapping / defaults (tolerant reads, never a throw)", () => {
    expect(resolveAttachState({ mode: "garbage" as never })).toEqual({ mode: "standalone", posture: "ok" });
    expect(resolveAttachState({ posture: "commit-pending" as never })).toEqual({ mode: "standalone", posture: "ok" });
    expect(resolveAttachState({ state: "garbage" as never })).toEqual({ mode: "standalone", posture: "ok" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Preserve-on-rewrite — bidirectional, the split's survival of invariant 5
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 preserve-on-rewrite — base and overlay rewrites never clobber each other", () => {
  it("mergeAttachState preserves every field the patch does not name", () => {
    const record: AttachStateRecord = {
      mode: "fleet",
      posture: "degraded",
      state: "degraded",
      fleet_program: { thresholds: { hubDown: 3 } },
      custom_badge: "premium-v1",
    };
    const merged = mergeAttachState(record, { posture: "ok", state: "fleet" });
    expect(merged).toEqual({
      mode: "fleet",
      posture: "ok",
      state: "fleet",
      fleet_program: { thresholds: { hubDown: 3 } },
      custom_badge: "premium-v1",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The mode machine — the SOLE attach-state writer
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 ModeMachine — the sole attach-state writer (ADR-0005 decisions 1–3)", () => {
  it("writePosture writes ONLY the posture field (+ its legacy projection): mode and overlay fields are preserved", () => {
    const machine = new ModeMachine({
      initial: { mode: "fleet", state: "fleet", fleet_program: "overlay-data-v1" },
    });
    machine.writePosture("hub-down", "sustained: 3 consecutive no-responses");
    const read = machine.read();
    expect(read.posture).toBe("hub-down");
    expect(read.mode).toBe("fleet"); // the human-confirmed membership is untouched
    expect(read.record.state).toBe("standalone"); // the dual-written legacy projection
    expect(read.record.fleet_program).toBe("overlay-data-v1"); // overlay fields survive
  });

  it("confirmMode writes ONLY the mode field: posture and overlay fields are preserved", () => {
    const machine = new ModeMachine({
      initial: { posture: "hub-down", state: "standalone", fleet_program: "overlay-data-v1" },
    });
    machine.confirmMode("fleet", "human confirm: enroll");
    const read = machine.read();
    expect(read.mode).toBe("fleet");
    expect(read.posture).toBe("hub-down"); // transport's rendering is untouched by the human's membership write
    expect(read.record.fleet_program).toBe("overlay-data-v1");
  });

  it("a machine booted on a legacy record maps it on read (the migration read path)", () => {
    const machine = new ModeMachine({ initial: { state: "standalone" } });
    const read = machine.read();
    expect(read.mode).toBe("standalone");
    expect(read.posture).toBe("hub-down");
  });

  it("the write log tags every write with its writer and field — posture writes are transport, mode writes are human-confirm", () => {
    const machine = new ModeMachine();
    machine.writePosture("degraded", "transient timeout");
    machine.confirmMode("fleet", "human confirm");
    const log = machine.writeLog();
    expect(log.length).toBe(2);
    expect(log[0]).toMatchObject({ writer: "transport", field: "posture" });
    expect(log[1]).toMatchObject({ writer: "human-confirm", field: "mode" });
  });

  it("n_transport_derived_mode_field_writes == 0 by construction — no transport write ever names the mode field", () => {
    const machine = new ModeMachine({ initial: { mode: "fleet" } });
    for (const p of ["ok", "degraded", "hub-down", "degraded", "ok"] as const) {
      machine.writePosture(p, "injected transport outcome");
    }
    expect(machine.transportModeWriteCount()).toBe(0);
    expect(machine.read().mode).toBe("fleet");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The overlay rewrite path — machine-owned fields are never clobbered
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 overlay rewrites — machine-owned fields survive staged overlay data", () => {
  it("an overlay rewrite updates its own fields and preserves mode + posture (an overlay patch naming mode/posture is ignored for them)", () => {
    const machine = new ModeMachine({ initial: { mode: "fleet", posture: "degraded" } });
    machine.overlayRewrite({ fleet_program: "v2", mode: "standalone", posture: "ok" });
    const read = machine.read();
    expect(read.record.fleet_program).toBe("v2"); // the overlay's own field landed
    expect(read.mode).toBe("fleet"); // the human-confirmed mode survived
    expect(read.posture).toBe("degraded"); // the transport-written posture survived
  });

  it("a base rewrite preserves overlay-written fields it does not understand", () => {
    const machine = new ModeMachine();
    machine.overlayRewrite({ fleet_program: { hubDown: 5 }, unknown_future_field: true });
    machine.confirmMode("fleet");
    machine.writePosture("hub-down", "sustained");
    const read = machine.read();
    expect(read.record.fleet_program).toEqual({ hubDown: 5 });
    expect(read.record.unknown_future_field).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The render-only exemption — posture writes never touch a journal
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 the serialization/journal exemption (row 3's render-only posture writes)", () => {
  it("posture writes are render-only: the MODE journal exists as a surface and NO posture write ever lands in it", () => {
    const machine = new ModeMachine();
    machine.writePosture("degraded", "transient");
    machine.writePosture("hub-down", "sustained");
    machine.writePosture("ok", "recovered");
    // the write log is a render record, not a journal…
    expect(machine.writeLog().length).toBe(3);
    // …and the mode journal — where commit-pending and human confirms will
    // persist (P4a-2) — stays EMPTY: posture transitions are exempt
    expect(machine.journal()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The structural event surface — typed events for the P4a-3 queue, nothing more
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 structural signals — typed events, no behavior beyond emission", () => {
  it("emitStructural stamps a typed event, notifies listeners, logs it — and writes NO attach-state field", () => {
    const machine = new ModeMachine({ initial: { mode: "fleet", posture: "ok" } });
    const seen: unknown[] = [];
    machine.onStructural((e) => seen.push(e));
    const recordBefore = machine.read().record;
    const writesBefore = machine.writeLog().length;

    const emitted = machine.emitStructural({ class: "auth-revoked", detail: "hub answered HTTP 401 mid-flight" });

    expect(emitted.kind).toBe("structural");
    expect(emitted.class).toBe("auth-revoked");
    expect(emitted.detail).toContain("401");
    expect(typeof emitted.at).toBe("string");
    expect(seen).toEqual([emitted]);
    expect(machine.structuralEvents()).toEqual([emitted]);
    // no behavior beyond emission: the record and the write log are untouched
    expect(machine.read().record).toEqual(recordBefore);
    expect(machine.writeLog().length).toBe(writesBefore);
  });

  it("the structural classes are the named row-3 set: auth-revoked, mode-changed-elsewhere, presumed-structural", () => {
    const machine = new ModeMachine();
    machine.emitStructural({ class: "auth-revoked" });
    machine.emitStructural({ class: "mode-changed-elsewhere" });
    machine.emitStructural({ class: "presumed-structural" });
    expect(machine.structuralEvents().map((e) => e.class)).toEqual([
      "auth-revoked",
      "mode-changed-elsewhere",
      "presumed-structural",
    ]);
  });
});
