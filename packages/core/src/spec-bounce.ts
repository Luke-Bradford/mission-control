/** Why a review failed a PR on spec: what the ticket lacked, as far as the finding text shows. */
export const SPEC_BOUNCE_CAUSES = [
  "no-done-when",
  "missing-reference",
  "scope-wider",
  "ambiguous-wording",
  "other",
] as const;
export type SpecBounceCause = (typeof SPEC_BOUNCE_CAUSES)[number];

/** Rules in the order they are tried; the first whose pattern is in the finding text wins. */
const RULES: readonly [Exclude<SpecBounceCause, "other">, RegExp][] = [
  [
    "scope-wider",
    /out(?:side)? (?:of )?(?:the )?(?:ticket|scope)|beyond (?:the )?(?:ticket|scope)|scope creep|wider than|not asked for|unrequested|unrelated change/i,
  ],
  [
    "missing-reference",
    /mock-?up|prototype|no page|which page|page (?:is )?(?:not )?(?:named|referenced|reference)|design (?:link|reference)|no reference|(?:does not|doesn't|did not|never|fails? to) (?:name|reference|link|mention|show|say) (?:a |an |the |which |any )?(?:page|screen|view|design)|(?:page|screen) (?:name|reference|link) (?:is |was )?(?:missing|absent)|(?:missing|no|without a?) (?:page|screen) (?:name|reference|link)/i,
  ],
  [
    "ambiguous-wording",
    /ambigu|unclear|underspecified|under-specified|vague|could mean|either reading|open to (?:more than one )?interpretation/i,
  ],
  [
    "no-done-when",
    /done[- ]when|acceptance criteri|no criterion|no criteria|not covered by (?:the )?ticket|ticket (?:does not|doesn't) (?:say|cover) (?:the |this |that )?(?:case|behaviour|behavior|criteri)/i,
  ],
];

/**
 * The cause of one spec bounce, from the finding text and the ticket's Done-when lines at the
 * time. Deterministic keyword rules, no model; a ticket with no Done-when lines lacked one.
 */
export function classifySpecBounce(
  findingText: string,
  doneWhenLines: readonly string[],
): SpecBounceCause {
  for (const [cause, pattern] of RULES) if (pattern.test(findingText)) return cause;
  return doneWhenLines.length === 0 ? "no-done-when" : "other";
}

/** One PR's spec-failed review rounds for one cause. */
export interface AuditSpecBounce {
  repoId: string;
  /** `repo#n` as stored; null when the author run has no ticket. */
  ticket: string | null;
  pr: number;
  cause: SpecBounceCause;
  /** Review rounds on this PR whose spec verdict failed with this cause. */
  rounds: number;
  /** The finding summaries (or the review summary when it had none), oldest first. */
  findings: string[];
  /** When the latest such round ended. */
  at: number;
}

/** Spec-failed rounds per cause over the 7 and 30 days up to the range end. */
export interface AuditSpecBounceCount {
  cause: SpecBounceCause;
  days7: number;
  days30: number;
}
