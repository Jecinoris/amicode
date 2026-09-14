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
// THE LANDED SHAPE (the contract owner's manifest, amicissimo#418 — the
// freeze validator fleet_overlay/program.py + freeze.py define it): the
// manifest carries `surfaces` — an ARRAY of fleet-class surface objects
// (ids `transport-classifier-tuning`, `mode-transition-budgets`,
// `proposal-queue-tuning`), each with a `fields` array of DESCRIPTOR
// objects `{name, base_default, value, composes, base_version, description}`
// — not plain numbers. The consumer maps surface id → section
// (transport-classifier-tuning → classifier, mode-transition-budgets →
// engine, proposal-queue-tuning → queue), validates each descriptor, and
// composes `value` per knob. `composes` (module:interface.knob — the names
// mirror the amicode option surfaces exactly) is validated against the base
// knob it claims; `base_default` is CROSS-CHECKED against the installed
// base's DEFAULT_* constants — a disagreement is a named skew/drift finding
// in the receipt (never silently accepted); `description`/`base_version`
// per field are documentation.
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
//   a documented base knob. An unknown field — top-level, surface, field
//   name, or descriptor key — is REJECTED LOUDLY (the freeze validator's
//   unclassified class mirrored: the base never silently ignores a value it
//   doesn't understand). Rejection is whole-program: a partially-understood
//   tuned program is never composed (tuned values are coherent as a set).
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

/** The program's lawful surfaces — 1:1 onto the base injectable surfaces,
 *  the surface ids the contract owner's freeze validator enumerates
 *  (fleet_overlay.freeze.PROGRAM_SURFACE_IDS), mapped to the section of the
 *  composed values each feeds. The knob names ARE the base option-surface
 *  names (TransportClassifierConfig / ModeTransitionConfig /
 *  ProposalQueueConfig), mirrored exactly per amicissimo#418's contract;
 *  the defaults cited are the base's own constants (one vocabulary source —
 *  never a fork of the values). The module:interface pair per section is
 *  the `composes` reference the base documents each knob on. */
const PROGRAM_SURFACES: Record<
  string,
  {
    section: "classifier" | "engine" | "queue";
    module: string;
    interface: string;
    knobs: Record<string, number>;
  }
> = {
  "transport-classifier-tuning": {
    section: "classifier",
    module: "transport_classifier.ts",
    interface: "TransportClassifierConfig",
    knobs: { ...DEFAULT_TRANSPORT_CLASSIFIER_CONFIG },
  },
  "mode-transition-budgets": {
    section: "engine",
    module: "attach_state.ts",
    interface: "ModeTransitionConfig",
    knobs: { ...DEFAULT_MODE_TRANSITION_CONFIG },
  },
  "proposal-queue-tuning": {
    section: "queue",
    module: "proposal_queue.ts",
    interface: "ProposalQueueConfig",
    knobs: { ...DEFAULT_PROPOSAL_QUEUE_CONFIG },
  },
};

/** Documentation keys (the shipped manifests' `_comment` header precedent) —
 *  named, exempt; everything else unknown is a loud rejection. `surfaces`
 *  is the program body (the contract owner's landed shape). */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "overlay_id",
  "overlay_version",
  "base_version",
  "surfaces",
  "_comment",
]);

/** The keys a surface object may carry (`fleet_class` is the ADR-0004 d3
 *  declaration the freeze validator checks amicissimo-side — understood
 *  here as documentation, like `_comment`). */
const KNOWN_SURFACE_KEYS = new Set(["surface_id", "fleet_class", "fields"]);

/** The keys a field descriptor may carry — the freeze validator's
 *  KNOWN_FIELD_KEYS ({name, base_default, description}) plus the program
 *  layer's PROGRAM_FIELD_KEYS ({composes, base_version, value}). Anything
 *  else is unclassified → loud rejection, never silently ignored. */
const KNOWN_FIELD_DESCRIPTOR_KEYS = new Set([
  "name",
  "base_default",
  "value",
  "composes",
  "base_version",
  "description",
]);

export type FleetProgramAbsenceReason =
  | "overlay-source-absent"
  | "manifest-absent"
  | "manifest-invalid"
  | "program-envelope-invalid"
  | "program-invalid";

export interface FleetProgramRejection {
  /** The manifest path the rejection names (e.g. `surfaces.<sid>.<knob>`). */
  path: string;
  reason: string;
}

export interface FleetProgramComposedField {
  /** The composed knob's manifest path (e.g. `surfaces.<sid>.<knob>`). */
  path: string;
  /** The program's tuned value. */
  value: number;
  /** The base default it replaces — the INSTALLED base's constant (the
   *  provenance stamp per ADR-0003 decision 7: which base value each
   *  overlay field composes). The manifest's own `base_default` claim is
   *  cross-checked against this; disagreement lands in `drift`. */
  base_default: number;
}

/** A named skew/drift finding (the ADR-0003 d7 field-by-field check, the
 *  base_default leg): the manifest's `base_default` claim for a knob
 *  disagrees with the installed base's shipped constant. Composition is
 *  NOT blocked by drift (the tuned `value` is explicit and validated) —
 *  but it is never silent: every drift lands here, on the receipt. */
export interface FleetProgramDrift {
  /** The manifest path the drift names (e.g. `surfaces.<sid>.<knob>`). */
  path: string;
  /** The manifest's claimed base default. */
  manifest_base_default: number;
  /** The installed base's shipped constant — the truth the field replaces. */
  installed_base_default: number;
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
  /** Named drift: the manifest's `base_default` documentation disagrees
   *  with the installed base's constant — surfaced, never silently
   *  accepted (composition still proceeds; the tuned `value` is explicit). */
  drift?: FleetProgramDrift[];
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

/** One knob's manifest path (`surfaces.<surface_id>.<knob>`). */
function knobPath(surfaceId: string, knob: string): string {
  return `surfaces.${surfaceId}.${knob}`;
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

  // The per-field revalidation: every field descriptor must map 1:1 onto a
  // documented base knob — the knob the surface feeds, the `composes`
  // pointer it claims, a positive finite numeric tuned value, and a
  // `base_default` that agrees with the installed base's constant (a
  // disagreement is a named drift finding, never silently accepted).
  // Field-by-field verdicts are collected — composition is lawful only when
  // EVERY field holds (a partially-understood tuned program is never
  // composed; tuned values are coherent as a set).
  const surfaces = m.surfaces;
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    receipt.rejections.push({
      path: "surfaces",
      reason: "program manifest carries no surfaces list — the program stages fleet-class surfaces; nothing to compose",
    });
    receipt.absence_reason = "program-invalid";
    return { composed: false, values: {}, receipt };
  }

  const values: FleetProgramValues = {};
  const composedFields: FleetProgramComposedField[] = [];
  const drift: FleetProgramDrift[] = [];
  const fieldRejections: FleetProgramRejection[] = [];
  const seenKnobs = new Set<string>();
  const seenSurfaces = new Set<string>();

  for (const rawSurface of surfaces) {
    if (typeof rawSurface !== "object" || rawSurface === null || Array.isArray(rawSurface)) {
      fieldRejections.push({
        path: "surfaces",
        reason: "program surface is not a JSON object",
      });
      continue;
    }
    const surface = rawSurface as Record<string, unknown>;
    const surfaceId = typeof surface.surface_id === "string" && surface.surface_id !== "" ? surface.surface_id : null;
    if (surfaceId === null) {
      fieldRejections.push({
        path: "surfaces",
        reason: "program surface is missing a surface_id — the base never silently ignores a value it does not understand",
      });
      continue;
    }
    if (!PROGRAM_SURFACES[surfaceId]) {
      fieldRejections.push({
        path: `surfaces.${surfaceId}`,
        reason: `unknown program surface: ${surfaceId} — the fleet program's lawful surfaces are ${Object.keys(PROGRAM_SURFACES).join(", ")}`,
      });
      continue;
    }
    if (seenSurfaces.has(surfaceId)) {
      fieldRejections.push({
        path: `surfaces.${surfaceId}`,
        reason: `duplicate program surface: ${surfaceId} — tuned values are coherent as a set; a surface staged twice is ambiguous`,
      });
      continue;
    }
    seenSurfaces.add(surfaceId);

    const unknownSurfaceKeys = Object.keys(surface).filter((k) => !KNOWN_SURFACE_KEYS.has(k));
    if (unknownSurfaceKeys.length > 0) {
      fieldRejections.push({
        path: `surfaces.${surfaceId}`,
        reason: `unknown program surface field(s) on ${surfaceId}: ${unknownSurfaceKeys.join(", ")} — the base never silently ignores a value it does not understand`,
      });
      continue;
    }

    const fields = surface.fields;
    if (!Array.isArray(fields)) {
      fieldRejections.push({
        path: `surfaces.${surfaceId}`,
        reason: `surface ${surfaceId} carries no fields list`,
      });
      continue;
    }

    const spec = PROGRAM_SURFACES[surfaceId];
    for (const rawField of fields) {
      if (typeof rawField !== "object" || rawField === null || Array.isArray(rawField)) {
        fieldRejections.push({
          path: `surfaces.${surfaceId}`,
          reason: "field descriptor is not a JSON object",
        });
        continue;
      }
      const field = rawField as Record<string, unknown>;
      const knob = typeof field.name === "string" && field.name !== "" ? field.name : null;
      const path = knobPath(surfaceId, knob ?? "<unnamed>");
      if (knob === null) {
        fieldRejections.push({
          path,
          reason: `field descriptor on ${surfaceId} carries no name`,
        });
        continue;
      }
      if (!Object.hasOwn(spec.knobs, knob)) {
        fieldRejections.push({
          path,
          reason: `unknown knob: ${path} — the base never silently ignores a value it does not understand`,
        });
        continue;
      }
      if (seenKnobs.has(`${spec.section}.${knob}`)) {
        fieldRejections.push({
          path,
          reason: `duplicate knob: ${path} — tuned values are coherent as a set; a knob staged twice is ambiguous`,
        });
        continue;
      }
      seenKnobs.add(`${spec.section}.${knob}`);

      const unknownFieldKeys = Object.keys(field).filter((k) => !KNOWN_FIELD_DESCRIPTOR_KEYS.has(k));
      if (unknownFieldKeys.length > 0) {
        fieldRejections.push({
          path,
          reason: `field ${path} carries unclassified descriptor key(s): ${unknownFieldKeys.join(", ")} — unclassified field keys default to reject (the ADR-0003 table-driven floor)`,
        });
        continue;
      }

      // Provenance (ADR-0003 d7): the `composes` pointer must name the base
      // knob it claims — module:interface.knob, the names mirroring the
      // amicode option surfaces exactly. A wrong pointer is a rejection
      // naming BOTH the manifest's claim and the base's documented ref.
      const expectedRef = `${spec.module}:${spec.interface}.${knob}`;
      const composes = typeof field.composes === "string" && field.composes !== "" ? field.composes : null;
      if (composes === null) {
        fieldRejections.push({
          path,
          reason: `field ${path} carries no composes stamp — every field stamps the base knob it composes (ADR-0003 decision 7; the base documents ${expectedRef})`,
        });
        continue;
      }
      if (composes !== expectedRef) {
        fieldRejections.push({
          path,
          reason: `field ${path} stamps composes=${composes} — the base documents this knob on ${expectedRef}`,
        });
        continue;
      }

      if (!("base_default" in field)) {
        fieldRejections.push({
          path,
          reason: `field ${path} carries no base_default — the base reader must always have a value to fall back to`,
        });
        continue;
      }

      const value = field.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        fieldRejections.push({
          path,
          reason: `value for ${path} must be a positive finite number, got ${String(value)}`,
        });
        continue;
      }

      // The base_default cross-check (the ADR-0003 d7 field-by-field check,
      // the strongest leg): the manifest CLAIMS what the base ships; the
      // installed base's constant is the truth. Disagreement is named drift
      // — surfaced on the receipt, never silently accepted. It does not
      // block composition: the tuned `value` is explicit and validated, and
      // the composed_fields record stamps the INSTALLED constant.
      const installedDefault = spec.knobs[knob];
      const manifestDefault = field.base_default;
      if (
        typeof manifestDefault !== "number" ||
        !Number.isFinite(manifestDefault) ||
        manifestDefault !== installedDefault
      ) {
        drift.push({
          path,
          manifest_base_default:
            typeof manifestDefault === "number" ? manifestDefault : Number.NaN,
          installed_base_default: installedDefault,
        });
      }

      (values as Record<string, Record<string, number>>)[spec.section] ??= {};
      (values as Record<string, Record<string, number>>)[spec.section]![knob] = value;
      composedFields.push({ path, value, base_default: installedDefault });
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
      path: "surfaces",
      reason: "program declares no known tuning fields — nothing to compose",
    });
    receipt.absence_reason = "program-invalid";
    return { composed: false, values: {}, receipt };
  }
  if (drift.length > 0) {
    receipt.drift = drift;
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
  if (result.receipt.drift?.length) parts.push(`(drift named: ${result.receipt.drift.length})`);
  return parts.join(" ");
}
