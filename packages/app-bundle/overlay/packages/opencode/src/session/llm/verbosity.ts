// Verbosity rules injected into the system prompt per-turn.
// "medium" has no entry — it means "inject nothing."
//
// These must be FORCEFUL — they compete with a long existing system prompt.
// Structural constraints (hard limits, explicit bans) work; suggestions don't.
//
// The user controls verbosity. Terse means terse, always. If they want a
// detailed report, they switch to detailed — that's the point of the control.

export const VerbosityRules: Record<string, string> = {
  terse: [
    "=== VERBOSITY OVERRIDE: TERSE MODE ===",
    "These rules SUPERSEDE all prior formatting, length, and style instructions. Obey them literally.",
    "",
    "HARD LIMIT: Your ENTIRE response — including bullets, lists, everything — must be under 100 words. LaTeX equations and code blocks don't count toward this limit.",
    "",
    "ABSOLUTE BANS:",
    "- NO headings, NO tables, NO bold section titles",
    "- NO bullet lists at all — write prose",
    "- NO questions back to the user ('What angle...?', 'Want to...?', 'Which...')",
    "- NO introductory filler, NO closing filler",
    "",
    "PERMITTED: LaTeX display equations ($$...$$) and inline math ($...$) are fine and encouraged where they aid clarity.",
    "",
    "STRUCTURE: One or two equations if relevant, then 2-4 sentences of plain prose covering the essentials. Stop.",
    "",
    "This applies to EVERYTHING — explanations, reports, summaries, code reviews, research findings. Terse means terse.",
    "",
    "Model this: a Slack DM from someone who knows the answer cold and values your time.",
  ].join("\n"),
  detailed: [
    "=== VERBOSITY OVERRIDE: DETAILED MODE ===",
    "These rules SUPERSEDE all prior instructions that limit output length or encourage brevity. Obey them literally.",
    "",
    "TARGET LENGTH: 40-80 lines. Do NOT compress. A thorough long answer is what the user wants.",
    "",
    "REQUIRED STRUCTURE:",
    "- Use ## and ### headings to organize the answer into sections",
    "- Use tables for any enumerable comparisons",
    "- Use bullet lists for properties, variants, or examples",
    "",
    "REQUIRED CONTENT:",
    "- Explain WHY, not just what — show the reasoning, derivation, or motivation",
    "- Surface at least 2 alternatives or related concepts the user didn't ask about",
    "- Include concrete examples, applications, or analogies",
    "- For every claim, cite the source or explain the reasoning chain",
    "- Cover edge cases, gotchas, and common misconceptions",
    "- End with 2-3 pointers for further exploration",
  ].join("\n"),
}

export const VerbosityLevels = ["terse", "medium", "detailed"] as const
export type VerbosityLevel = (typeof VerbosityLevels)[number]

export const resolveVerbositySystem = (level: string | undefined): string | undefined =>
  level ? VerbosityRules[level] : undefined

// Short 1-line reminder injected right before the current user message in the
// conversation history. This breaks pattern-matching when the user switches
// verbosity mid-session — without it the model sees N messages of one style
// and pattern-matches on those, ignoring the system prompt change.
export const VerbosityReminder: Record<string, string> = {
  terse: "ACTIVE MODE: terse. Under 100 words, no headings, no lists, no questions back. Prose only. Obey this for the next response.",
  detailed: "ACTIVE MODE: detailed. Be thorough — 40+ lines, use headings/tables/lists, explain reasoning, surface alternatives. Obey this for the next response.",
}

export const resolveVerbosityReminder = (level: string | undefined): string | undefined =>
  level ? VerbosityReminder[level] : undefined

export * as Verbosity from "./verbosity"
