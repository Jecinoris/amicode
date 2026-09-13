// Generator for the vault card/record contract files (amicode#496).
// Single source of truth: the type tables below; the generated .schema.json
// files are the committed open contract (canonical JSON, sorted keys, so
// diffs are stable). Run: node vault-schemas/generate.mjs
//
// Convention notes that matter for consumers:
// - additionalProperties is true everywhere: legacy cards carry platform
//   extras; unknown-field flagging is the schema-check skill's job, not a
//   schema-level refusal (spec-20260821-090401, card-families note).
// - Every card schema carries the sentinel rule (Amendment-era semantics):
//   `provenance_unrecoverable: true` requires an empty provenance list and a
//   `reviewed_after` pointer.
// - Tombstone conditionals: the closed justification vocabulary plus
//   justification-specific required fields (pointer / original_review_by /
//   review_pointer), per D2 + Amendments 1-2.
// - Physical quantities are bounded (reviewer pass #517): fidelity ∈ [0, 1],
//   duration_us >= 0 — the engine enforces minimum/maximum.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const str = { type: "string", minLength: 1 };
const date = { type: "string", format: "date" };
const num = { type: "number" };
const stringArray = { type: "array", items: { type: "string" } };

// Optional extension fields every card type accepts (spec: Card families).
const EXTENSIONS = {
  provenance: { type: "array", items: { type: "string" } },
  provenance_unrecoverable: { type: "boolean" },
  reviewed_after: str,
  confidence: { enum: ["low", "medium", "high"] },
  review_by: date,
  subject: str,
};

// The sentinel rule, applied to every card type.
const SENTINEL_RULE = {
  if: {
    properties: { provenance_unrecoverable: { const: true } },
    required: ["provenance_unrecoverable"],
  },
  then: {
    properties: { provenance: { maxItems: 0 } },
    required: ["reviewed_after"],
  },
};

// The 12 legacy (schema-check) types — aligned to `amico-vault`'s YAML
// Frontmatter Schemas, the single owner since PR #1052 (skills-integrity
// F26: the old amico-schema-check table had drifted — insight's phantom
// required `source`, paper's wrong `date`, missing session_id/visibility
// floors, etc.). Required sets mirror the aligned amico-schema-check table
// field for field; amico-vault's closed vocabularies (task_type, statuses,
// relevance, outcome, failure_mode, device_class, relationship, visibility,
// experiment's ingest `source`) are enums; optional/nullable fields
// (experiment's source_path/warm_started_from, spec's priority/platform/
// linked_plan, hypothesis's platform, person's contact) are declared but
// never required — their absence is not a schema violation.
// session_id is REQUIRED but nullable (uuid on agent notes, null on
// human-curated ones, present either way — amico-vault "Session ID"):
// `type: ["string", "null"]` is the honest JSON-Schema union; the shipped
// subset validator treats a type array as unchecked (under-validation, not
// mis-validation) while `required` still enforces presence.
const nullableStr = { type: ["string", "null"], minLength: 1 };
const LEGACY = {
  experiment: {
    properties: {
      task_type: { enum: ["experiment", "validation", "regression", "reproduction", "parameter-study"] },
      date,
      session_id: nullableStr,
      source: { enum: [null, "demo-ingest", "doc-ingest", "agent"] },
      source_path: nullableStr,
      platform: str,
      gate: str,
      fidelity: { type: "number", minimum: 0, maximum: 1 },
      duration_us: { type: "number", minimum: 0 },
      status: { enum: ["running", "completed", "failed", "stalled"] },
      failure_mode: { enum: [null, "stagnation", "divergence", "constraint_violation", "infeasible"] },
      warm_started_from: nullableStr,
      tags: stringArray,
    },
    required: ["type", "task_type", "date", "session_id", "platform", "gate", "fidelity", "duration_us", "status", "tags"],
  },
  insight: {
    properties: { date, session_id: nullableStr, evidence: stringArray, confidence: { enum: ["high", "medium", "low"] }, tags: stringArray },
    required: ["type", "date", "session_id", "evidence", "confidence", "tags"],
  },
  hypothesis: {
    properties: { date, session_id: nullableStr, status: { enum: ["open", "untested", "confirmed", "refuted", "abandoned"] }, platform: nullableStr, evidence: stringArray, tags: stringArray },
    required: ["type", "date", "session_id", "status", "evidence", "tags"],
  },
  method: {
    properties: { name: str, date, session_id: nullableStr, applicability: stringArray, tags: stringArray },
    required: ["type", "name", "date", "session_id", "applicability", "tags"],
  },
  paper: {
    properties: { arxiv: str, title: str, authors: stringArray, date_read: date, session_id: nullableStr, relevance: { enum: ["high", "medium", "low"] }, systems: stringArray, tags: stringArray },
    required: ["type", "arxiv", "title", "authors", "date_read", "session_id", "relevance", "systems", "tags"],
  },
  spec: {
    properties: { date, session_id: nullableStr, status: { enum: ["draft", "approved", "in-progress", "completed", "abandoned"] }, priority: nullableStr, platform: nullableStr, linked_plan: nullableStr, tags: stringArray, visibility: { enum: ["local", "team", "public"] } },
    required: ["type", "date", "session_id", "status", "tags", "visibility"],
  },
  plan: {
    properties: { date, session_id: nullableStr, status: { enum: ["draft", "approved", "executing", "completed", "abandoned", "failed"] }, spec: str, tags: stringArray, visibility: { enum: ["local", "team", "public"] } },
    required: ["type", "date", "session_id", "status", "spec", "tags", "visibility"],
  },
  retrospective: {
    properties: { date, session_id: nullableStr, outcome: { enum: ["success", "partial", "failed", "abandoned"] }, tags: stringArray },
    required: ["type", "date", "session_id", "outcome", "tags"],
  },
  person: {
    properties: { name: str, org: str, role: str, contact: nullableStr, tags: stringArray },
    required: ["type", "name", "org", "role", "tags"],
  },
  org: {
    properties: { name: str, domain: str, relationship: { enum: ["partner", "customer", "academic"] }, tags: stringArray },
    required: ["type", "name", "domain", "relationship", "tags"],
  },
  device: {
    properties: { name: str, status: { enum: ["online", "offline", "maintenance"] }, device_class: { enum: ["classical", "quantum"] }, platforms: stringArray, location: str, tags: stringArray },
    required: ["type", "name", "status", "device_class", "platforms", "location", "tags"],
  },
  meeting: {
    properties: { date, attendees: stringArray, org: str, topic: str, tags: stringArray },
    required: ["type", "date", "attendees", "org", "topic", "tags"],
  },
};

// The 4 memory families (amicode/memory/* cards).
const MEMORY = {
  feedback: {
    properties: { name: str, description: str, status: str, date, tags: stringArray },
    required: ["type", "name", "description"],
  },
  project: {
    properties: { name: str, description: str, status: str, date, tags: stringArray },
    required: ["type", "name", "description"],
  },
  reference: {
    properties: { name: str, description: str, status: str, date, tags: stringArray },
    required: ["type", "name", "description"],
  },
  user: {
    properties: { name: str, description: str, status: str, date, tags: stringArray },
    required: ["type", "name", "description"],
  },
};

const TENSION = {
  properties: {
    date,
    subject: str,
    a_cards: { type: "array", items: { type: "string" }, minItems: 1 },
    b_cards: { type: "array", items: { type: "string" }, minItems: 1 },
    evidence: stringArray,
    tags: stringArray,
  },
  required: ["type", "date", "subject", "a_cards", "b_cards", "tags"],
};

const TOMBSTONE_JUSTIFICATIONS = [
  "superseded_by",
  "expired_ttl",
  "provenance_unrecoverable",
  "redundant_with",
  "filed_to",
  "lifecycle_complete",
];

const TOMBSTONE = {
  properties: {
    date,
    tags: stringArray,
    justification: { enum: TOMBSTONE_JUSTIFICATIONS },
    tombstone_of: str,
    pointer: str,
    original_review_by: date,
    review_pointer: str,
  },
  required: ["type", "date", "justification", "tombstone_of"],
  conditionals: [
    {
      if: { properties: { justification: { const: "superseded_by" } }, required: ["justification"] },
      then: { required: ["pointer"] },
    },
    {
      if: { properties: { justification: { const: "redundant_with" } }, required: ["justification"] },
      then: { required: ["pointer"] },
    },
    {
      if: { properties: { justification: { const: "filed_to" } }, required: ["justification"] },
      then: { required: ["pointer"] },
    },
    {
      if: { properties: { justification: { const: "expired_ttl" } }, required: ["justification"] },
      then: { required: ["original_review_by"] },
    },
    {
      if: {
        properties: { justification: { const: "provenance_unrecoverable" } },
        required: ["justification"],
      },
      then: { required: ["review_pointer"] },
    },
  ],
};

// The minimal evidence-plane record schema (records, not cards: minimal
// frontmatter, append-only, outside card machinery).
const RECORD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.amicode.dev/vault/records/evidence-record.schema.json",
  title: "evidence record",
  type: "object",
  properties: {
    type: { enum: ["experiment", "meeting", "retrospective", "paper"] },
    date,
    origin: str,
  },
  required: ["type", "date", "origin"],
  additionalProperties: true,
};

// Plane residency: knowledge/ holds cards; evidence/ holds records; work/
// holds working documents. Per Amendment 2 (records-vs-cards distinction).
const RESIDENCY = {
  insight: { plane: "knowledge" },
  hypothesis: { plane: "knowledge" },
  method: { plane: "knowledge" },
  feedback: { plane: "knowledge" },
  project: { plane: "knowledge" },
  reference: { plane: "knowledge" },
  user: { plane: "knowledge" },
  tension: { plane: "knowledge" },
  tombstone: { plane: "knowledge", note: "written at the archived card's origin plane" },
  spec: { plane: "knowledge", note: "approved specs; drafts live in work/" },
  person: { plane: "knowledge" },
  org: { plane: "knowledge" },
  device: { plane: "knowledge" },
  plan: { plane: "work", note: "scaffolding — archives on landing via lifecycle_complete" },
  experiment: { plane: "evidence", note: "resides as a record (minimal frontmatter)" },
  meeting: { plane: "evidence", note: "resides as a record" },
  retrospective: { plane: "evidence", note: "resides as a record" },
  paper: { plane: "evidence", note: "resides as a record" },
};

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

function canonical(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function cardSchema(type, def) {
  const properties = { type: { const: type }, ...def.properties, ...EXTENSIONS };
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://schemas.amicode.dev/vault/cards/${type}.schema.json`,
    title: `${type} card`,
    type: "object",
    properties,
    required: def.required,
    additionalProperties: true,
    allOf: [SENTINEL_RULE, ...(def.conditionals ?? [])],
  };
  return schema;
}

const ALL = { ...LEGACY, ...MEMORY, tension: TENSION, tombstone: TOMBSTONE };

let written = 0;
const cardsDir = path.join(HERE, "cards");
const recordsDir = path.join(HERE, "records");
fs.mkdirSync(cardsDir, { recursive: true });
fs.mkdirSync(recordsDir, { recursive: true });

for (const [type, def] of Object.entries(ALL)) {
  fs.writeFileSync(path.join(cardsDir, `${type}.schema.json`), canonical(cardSchema(type, def)));
  written++;
}
fs.writeFileSync(path.join(recordsDir, "evidence-record.schema.json"), canonical(RECORD_SCHEMA));
written++;
fs.writeFileSync(path.join(HERE, "plane-residency.json"), canonical(RESIDENCY));
written++;

console.log(`wrote ${written} contract files (${Object.keys(ALL).length} card schemas + record + residency)`);
