---
name: dream-reflect
description: Generate structured retrospectives from Claude session transcripts. Use when running a dream cycle or reviewing past sessions.
agents: [dreamer]
surface: internal
---

# Dream: Reflect — Session Retrospectives

Generate structured retrospectives for sessions that lack them.

## Usage

`/dream reflect` — generate retros for all distilled sessions missing them.
`/dream reflect <session-uuid>` — generate retro for a specific session.

The argument is: $ARGUMENTS

## Instructions

### Step 0: Environment Setup

Before running any bash in this skill, compute the session transcript dir and resolve the vault this run writes retros to:

```bash
# Session transcripts: ~/.claude/projects/<cwd-with-slashes-as-dashes>/
AMICO_SESSIONS_DIR="$HOME/.claude/projects/$(echo "${AMICO_ROOT:-$PWD}" | tr / -)"

# Vault mounts.
VAULTS="${AMICO_VAULTS_ROOT:-$HOME/.amico/vaults}"
```

**Resolve the personal vault** — retros are personal-vault writes (per the `amico-vault` write-routing table: "personal research, sessions, scratch → personal vault"). Resolve the `kind = "personal"` mount under `$VAULTS` the same way dream:distill Step 0 does: `$AMICO_PERSONAL_VAULT` if set; otherwise the single `kind = "personal"` mount (excluding `armonia-issimo`); if zero or more than one, **stop and ask the user** — never guess, never fall back to `armonissima`. If no personal mount resolves on this machine, write to the highest-precedence writable mount and stamp frontmatter `route_intent: personal` (the `amico-vault` fallback).

### Step 1: Identify Sessions Needing Retros

1. Read `amico/vault/.dream-state.toml`.
2. Find sessions where `distilled` is set but `retro = false` (or retro field missing).
3. If `$ARGUMENTS` specifies a UUID, process only that one.

### Step 2: Generate Retrospective for Each Session

For each session:

#### 2a. Read Session Content

Use the same filtering approach as dream:distill:
```bash
grep -E '"type":"(user|assistant)"' "$AMICO_SESSIONS_DIR/{uuid}.jsonl" | \
  grep -v '"deferred_tools_delta"' | \
  grep -v '"system-reminder"' > /tmp/dream-reflect-{uuid}.jsonl
```

Read the filtered content. Focus on user messages and assistant text (not tool calls).

#### 2b. Extract Session Metadata

From the first few messages, determine:
- **Date**: from the JSONL `timestamp` field
- **Topic**: from the first user message content
- **Branch**: from the `gitBranch` field if present

#### 2c. Write Retrospective

Write to `$PERSONAL_VAULT/retrospectives/retro-YYYYMMDD-HHMMSS-{topic-slug}.md` (the personal vault resolved in Step 0 — never `armonissima`; a retro reaches the company vault only via dream-promote):

```yaml
---
type: retrospective
date: YYYY-MM-DD
session_id: "{uuid}"
outcome: success | partial | failed | abandoned
source: dream-reflect
tags: [retrospective, dream, ...]
---
```

Set `outcome` per `amico-vault`'s retrospective schema from what the session achieved: `success` (goal met), `partial` (some of it), `failed`, or `abandoned` — it is a required field, not prose.

Body sections:

```markdown
# Retrospective: {topic}

## Goal
What was the user trying to accomplish in this session?

## Outcome
What was achieved? Include specific results (fidelity numbers, files created, decisions made).

## Surprises
What was unexpected? Include things that worked better than expected, failed unexpectedly, or revealed something new.

## Unfinished
What was left incomplete or deferred? Include explicit TODOs and implicit next steps.

## Next Steps
What should follow from this session? Be specific and actionable.

## Lessons
What would make the next similar session more productive? Focus on process improvements, not just technical fixes.
```

### Step 3: Update State

For each processed session, update `.dream-state.toml`:
Set `retro = true` for the session entry.

### Step 4: Report

```
dream:reflect complete
  Retros generated: N
  Sessions: [uuid1, uuid2, ...]
```

## Quality Bars

- **Keep retros concise**: Each section should be 2-5 bullet points, not paragraphs.
- **Be specific**: "Fidelity improved from 99.95% to 99.99% using free-phase" not "things went well."
- **Focus on non-obvious lessons**: "The session spent 30 minutes debugging a typo in the Hamiltonian" is more useful than "we optimized a gate."
- **Link to vault**: Reference existing experiment notes, insights, methods with `[[wikilinks]]` where applicable.
