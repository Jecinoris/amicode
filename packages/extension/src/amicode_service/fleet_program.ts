// FLEET PROGRAM CONSUMPTION (#1131 — fleet rearchitect P4b, the amicissimo#418
// companion): the staged overlay PROGRAM — fleet_overlay/overlays/
// fleet-program.json — is the tuned VALUES for the mode-machine family's
// injectable knobs, composed into the EXISTING surfaces this slice builds
// on: #1070's classifier tuning (transport_classifier.ts), #1072's verify
// budget + commit-pending cap (attach_state.ts), #1092's queue retries
// (proposal_queue.ts). The base ships base defaults; NOTHING here re-defines
// a knob — the base option surfaces ARE the contract (the #1068 precedent:
// consume, never re-define — the knob table below is a map onto the shipped
// DEFAULT_* constants, not a second schema).
//
// The dispatch invariants, mirroring fleet_staging.ts (the gate the fleet
// surfaces stage through):
//
// - **Without the entitlement: the program is never even READ** — no fs
//   access below the gate; the receipt records entitlement:"absent" and
//   nothing composes. The solo floor is untouched, byte-identical (asserted
//   by the tests as: the composed config equals the base defaults EXACTLY).
// - **With the entitlement, composition is lawful or absent**: the program
//   manifest must carry the same envelope the freeze validator enforces
//   amicissimo-side (overlay_id / overlay_version=1 / base_version stamp —
//   provenance per ADR-0003 decision 7), and every field must map 1:1 onto
//   a documented base knob. An unknown field — top-level, section, or knob
//   — is REJECTED LOUDLY (the freeze validator's unclassified class
//   mirrored: the base never silently ignores a value it doesn't
//   understand). Rejection is whole-program: a partially-understood tuned
//   program is never composed (tuned values are coherent as a set).
// - **The ADR-0003 skew rule, client-side**: a program stamped against an
//   older base revalidates FIELD-BY-FIELD against the CURRENT base's knob
//   contract (this module's per-field validation is that revalidation);
//   every field holding → compose with the skew NAMED in the receipt; any
//   field failing → the program is skipped with the recorded per-field
//   reasons. Never silently merged stale.
// - **Absence and rejection are NAMED, never silent, never a dead end** —
//   every not-composed outcome carries its reason in the receipt, and the
//   receipt rides the fleet status detail (the cockpit says where its
//   tuning came from).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLocalEntitlements } from "../scores/entitlements";
import { PREMIUM_ENTITLEMENT, resolveOverlaySource } from "../mode_cards";
import {
  DEFAULT_TRANSPORT_CLASSIFIER_CONFIG,
  type TransportClassifierConfig,
} from "./transport_classifier";
import {
  DEFAULT_MODE_TRANSITION_CONFIG,
  type ModeTransitionConfig,
} from "./attach_state";
import {
  DEFAULT_PROPOSAL_QUEUE_CONFIG,
  type ProposalQueueConfig,
} from "./proposal_queue";
import { VENDORED_BASE_VERSION } from "./fleet_staging";

/** The program manifest's location under the resolved amicissimo source —
 *  the path amicissimo#418 stages (fleet_overlay/overlays/). */
export const FLEET_PROGRAM_MANIFEST_REL = join("fleet_overlay", "overlays", "fleet-program.json");

export const FLEET_PROGRAM_RECEIPT_VERSION = 1;

/** The program's three sections — 1:1 onto the base injectable surfaces.
 *  The knob names ARE the base option-surface names (TransportClassifierConfig
 *  / ModeTransitionConfig / ProposalQueueConfig), mirrored exactly per
 *  amicissimo#418's contract; the defaults cited are the base's own constants
 *  (one vocabulary source — never a fork of the values). */
const PROGRAM_KNOBS: Record<string, Record<string, number>> = {
  classifier: { ...DEFAULT_TRANSPORT_CLASSIFIER_CONFIG },
  engine: { ...DEFAULT_MODE_TRANSITION_CONFIG },
  queue: { ...DEFAULT_PROPOSAL_QUEUE_CONFIG },
};

/** Documentation keys (the shipped manifests' `_comment` header precedent) —
 *  named, exempt; everything else unknown is a loud rejection. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "overlay_id",
  "overlay_version",
  "base_version",
  "program",
  "_comment",
]);

export type FleetProgramAbsenceReason =
  | "overlay-source-absent"
  | "manifest-absent"
  | "manifest-invalid"
  | "program-envelope-invalid"
  | "program-invalid";

export interface FleetProgramRejection {
  /** The manifest path the rejection names (e.g. `program.classifier.X`). */
  path: string;
  reason: string;
}

export interface FleetProgramComposedField {
  /** The composed knob's manifest path (e.g. `program.classifier.X`). */
  path: string;
  /** The program's tuned value. */
  value: number;
  /** The base default it replaces — the provenance stamp per ADR-0003
   *  decision 7: which base value each overlay field composes. */
  base_default: number;
}

export interface FleetProgramReceipt {
  receipt_version: typeof FLEET_PROGRAM_RECEIPT_VERSION;
  resolved_at: string;
  entitlement: "present" | "absent";
  composed: boolean;
  /** Provenance (ADR-0003 decision 7): which program staged, against which
   *  base stamp — merge-record metadata, never a merged field. */
  overlay_id?: string;
  program_base_version?: string;
  /** Named skew: the program stamps a different base than the vendored pin
   *  — its fields were revalidated field-by-field against the installed
   *  base (see revalidated_fields); composition is lawful only when every
   *  field revalidates. */
  skew?: string;
  /** The field-by-field revalidation count (the skew check's evidence). */
  revalidated_fields?: number;
  /** Every knob the program composed, each stamped with the base default
   *  it replaces — the merge record, rendered on the fleet status detail. */
  composed_fields?: FleetProgramComposedField[];
  rejections: FleetProgramRejection[];
  /** Why the program did not compose despite the entitlement — the
   *  honest-setup pointer (never a silent no-op). */
  absence_reason?: FleetProgramAbsenceReason;
}

/** The composed values — partial overrides feeding the EXISTING injectable
 *  option surfaces (`config?: Partial<...>` on the three constructors).
 *  Empty everywhere = the base defaults, byte-identical. */
export interface FleetProgramValues {
  classifier?: Partial<TransportClassifierConfig>;
  engine?: Partial<ModeTransitionConfig>;
  queue?: Partial<ProposalQueueConfig>;
}

export interface ResolveFleetProgramOptions {
  /** Resolved entitlement codes; null resolves the machine's real set. */
  entitlements?: string[] | null;
  /** Directory holding entitlements.toml (default ~/.amico/amicode). */
  entitlementConfigDir?: string;
  /** Explicit overlay source root; null/undefined walks the resolution
   *  ladder (the mode-cards semantics, shared with fleet_staging). */
  overlaySource?: string | null;
  /** Clock injection (receipt timestamps); default real time. */
  now?: () => string;
}

export interface ResolveFleetProgramResult {
  composed: boolean;
  values: FleetProgramValues;
  receipt: FleetProgramReceipt;
}

function emptyReceipt(
  entitlement: "present" | "absent",
  now: string,
): FleetProgramReceipt {
  return { receipt_version: FLEET_PROGRAM_RECEIPT_VERSION, resolved_at: now, entitlement, composed: false, rejections: [] };
}

/** One knob's manifest path (`program.<section>.<knob>`). */
function knobPath(section: string, knob: string): string {
  return `program.${section}.${knob}`;
}

/**
 * Resolve the staged fleet program — the entitlement-gated read + validation
 * + composition of amicissimo#418's program manifest into the base knobs'
 * `Partial<...>` override shape. Never throws: every failure collapses into
 * a not-composed result with a named reason (consumption never dead-ends
 * the boot).
 */
export function resolveFleetProgram(opts: ResolveFleetProgramOptions = {}): ResolveFleetProgramResult {
  const nowIso = opts.now ?? (() => new Date().toISOString());

  // The entitlement gate FIRST — without it the overlay is never even read
  // (the resolver's rule, mirrored from fleet_staging). No fs access below
  // this point until the gate passes.
  const configDir = opts.entitlementConfigDir ?? join(homedir(), ".amico", "amicode");
  const entitlements = opts.entitlements ?? readLocalEntitlements(configDir).entitlements;
  const entitled = entitlements.includes(PREMIUM_ENTITLEMENT);
  if (!entitled) {
    return { composed: false, values: {}, receipt: emptyReceipt("absent", nowIso()) };
  }

  const receipt = emptyReceipt("present", nowIso());

  const source = resolveOverlaySource(opts.overlaySource);
  if (!source || !existsSync(source)) {
    receipt.absence_reason = "overlay-source-absent";
    return { composed: false, values: {}, receipt };
  }

  const manifestPath = join(source, FLEET_PROGRAM_MANIFEST_REL);
  if (!existsSync(manifestPath)) {
    receipt.absence_reason = "manifest-absent";
    return { composed: false, values: {}, receipt };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    receipt.rejections.push({
      path: FLEET_PROGRAM_MANIFEST_REL,
      reason: `malformed program manifest: ${e instanceof Error ? e.message : String(e)}`,
    });
    receipt.absence_reason = "manifest-invalid";
    return { composed: false, values: {}, receipt };
  }

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    receipt.rejections.push({ path: FLEET_PROGRAM_MANIFEST_REL, reason: "program manifest is not a JSON object" });
    receipt.absence_reason = "manifest-invalid";
    return { composed: false, values: {}, receipt };
  }
  const m = manifest as Record<string, unknown>;

  // The envelope — the freeze validator's provenance floor (ADR-0003 d7):
  // identity + version + the base stamp, or nothing composes.
  const overlayId = typeof m.overlay_id === "string" && m.overlay_id !== "" ? m.overlay_id : null;
  const programBaseVersion = typeof m.base_version === "string" && m.base_version !== "" ? m.base_version : null;
  if (overlayId === null || programBaseVersion === null || m.overlay_version !== 1) {
    receipt.rejections.push({
      path: FLEET_PROGRAM_MANIFEST_REL,
      reason: "program envelope incomplete (overlay_id / overlay_version=1 / base_version stamp)",
    });
    receipt.absence_reason = "program-envelope-invalid";
    return { composed: false, values: {}, receipt };
  }

  // Unknown top-level fields: rejected loudly (the freeze validator's
  // unclassified class — the base never silently ignores a value it does
  // not understand).
  const unknownTop = Object.keys(m).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
  if (unknownTop.length > 0) {
    receipt.rejections.push({
      path: FLEET_PROGRAM_MANIFEST_REL,
      reason: `unknown program field(s): ${unknownTop.join(", ")} — the base never silently ignores a value it does not understand`,
    });
    receipt.absence_reason = "program-invalid";
    return { composed: false, values: {}, receipt };
  }

  // The skew check (ADR-0003 d7, client-side): a program stamped against a
  // different base than the vendored pin revalidates FIELD-BY-FIELD against
  // the CURRENT base's knob contract — which is exactly the per-field
  // validation below; the skew is named in the receipt either way.
  const skew = programBaseVersion !== VENDORED_BASE_VERSION;
  if (skew) {
    receipt.skew =
      `program stamped base ${programBaseVersion}, vendored base ${VENDORED_BASE_VERSION} — ` +
      "revalidated field-by-field against the installed base at composition";
  }

  // The per-field revalidation: every field must map 1:1 onto a documented
  // base knob with a positive finite numeric value. Field-by-field verdicts
  // are collected — composition is lawful only when EVERY field holds (a
  // partially-understood tuned program is never composed; tuned values are
  // coherent as a set).
  const program = m.program;
  if (typeof program !== "object" || program === null || Array.isArray(program)) {
    receipt.rejections.push({
      path: "program",
      reason: "program manifest carries no program object",
    });
    receipt.absence_reason = "program-invalid";
    return { composed: false, values: {}, receipt };
  }
  const p = program as Record<string, unknown>;

  const values: FleetProgramValues = {};
  const composedFields: FleetProgramComposedField[] = [];
  const fieldRejections: FleetProgramRejection[] = [];

  for (const section of Object.keys(p)) {
    const knobs = PROGRAM_KNOBS[section];
    if (knobs === undefined) {
      fieldRejections.push({
        path: `program.${section}`,
        reason: `unknown program section: ${section} — the base never silently ignores a value it does not understand`,
      });
      continue;
    }
    const sectionValue = p[section];
    if (typeof sectionValue !== "object" || sectionValue === null || Array.isArray(sectionValue)) {
      fieldRejections.push({
        path: `program.${section}`,
        reason: `program section ${section} is not a JSON object`,
      });
      continue;
    }
    for (const [knob, raw] of Object.entries(sectionValue as Record<string, unknown>)) {
      const path = knobPath(section, knob);
      if (knobs[knob] === undefined) {
        fieldRejections.push({
          path,
          reason: `unknown knob: ${path} — the base never silently ignores a value it does not understand`,
        });
        continue;
      }
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        fieldRejections.push({
          path,
          reason: `value for ${path} must be a positive finite number, got ${String(raw)}`,
        });
        continue;
      }
      (values as Record<string, Record<string, number>>)[section] ??= {};
      (values as Record<string, Record<string, number>>)[section]![knob] = raw;
      composedFields.push({ path, value: raw, base_default: knobs[knob] });
    }
  }

  receipt.revalidated_fields = composedFields.length;
  if (fieldRejections.length > 0) {
    // never silently merged stale: every failing field is recorded, and
    // nothing composes
    receipt.rejections.push(...fieldRejections);
    receipt.absence_reason = "program-invalid";
    return { composed: false, values: {}, receipt };
  }
  if (composedFields.length === 0) {
    receipt.rejections.push({
      path: "program",
      reason: "program declares no known tuning fields — nothing to compose",
    });
    receipt.absence_reason = "program-invalid";
    return { composed: false, values: {}, receipt };
  }

  receipt.overlay_id = overlayId;
  receipt.program_base_version = programBaseVersion;
  receipt.composed_fields = composedFields;
  receipt.composed = true;
  return { composed: true, values, receipt };
}

/**
 * Compose the base defaults with a program's partial overrides — the helper
 * the machinery construction sites feed to the three constructors'
 * `config?: Partial<...>` seams. `composeFleetConfigs({})` IS the base
 * defaults exactly (the byte-identity floor's identity element).
 */
export function composeFleetConfigs(values: FleetProgramValues): {
  classifier: TransportClassifierConfig;
  engine: ModeTransitionConfig;
  queue: ProposalQueueConfig;
} {
  return {
    classifier: { ...DEFAULT_TRANSPORT_CLASSIFIER_CONFIG, ...(values.classifier ?? {}) },
    engine: { ...DEFAULT_MODE_TRANSITION_CONFIG, ...(values.engine ?? {}) },
    queue: { ...DEFAULT_PROPOSAL_QUEUE_CONFIG, ...(values.queue ?? {}) },
  };
}

/** Convenience for logging/boot lines: a one-line program summary. */
export function fleetProgramSummary(result: ResolveFleetProgramResult): string {
  if (result.receipt.entitlement === "absent") return "fleet program: entitlement absent — base defaults";
  if (!result.composed) {
    const why = result.receipt.absence_reason ?? result.receipt.rejections[0]?.reason ?? "unknown";
    return `fleet program: not composed (${why}) — base defaults`;
  }
  const parts = [
    `fleet program: composed via ${result.receipt.overlay_id}`,
    `base ${result.receipt.program_base_version}`,
    `${result.receipt.composed_fields?.length ?? 0} knobs`,
  ];
  if (result.receipt.skew) parts.push("(skew named)");
  return parts.join(" ");
}
