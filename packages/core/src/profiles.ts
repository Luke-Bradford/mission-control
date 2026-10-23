/**
 * Template profiles: the mockup's templates (feature, bugfix, small-change, research, review) as
 * data the operator keeps in user config. A profile sets the steps shown, the checklist briefed,
 * whether a plan is required, the reviewer, the CI checks and the try and round limits. The file
 * reader is the server's; this is the shape, the built-ins, the routing and the texts.
 */
import type { LoopPhase } from "./types.ts";

export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const PROFILE_STEP_PHASES = ["working", "ci", "review"] as const;
export type ProfileStepPhase = (typeof PROFILE_STEP_PHASES)[number];
export const REVIEW_DEPTHS = ["light", "full"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];
/** The sizes that go to small-change when no template label matches. */
export const SMALL_SIZES: readonly string[] = ["XS", "S"];
/** The model a full-depth review runs on. */
export const REVIEW_FULL_MODEL = "opus";
export const PROFILE_REASON_MAX = 300;

export interface Profile {
  name: string;
  /** Card labels that pick this profile. */
  labels: string[];
  /** The steps to display; `phase` ties a step to the loop phase it is shown in. */
  steps: { name: string; phase: ProfileStepPhase | null }[];
  /** Goes into the brief as the list to check before reporting. */
  checklist: string;
  planRequired: boolean;
  reviewer: { role: string; depth: ReviewDepth };
  /** CI checks that must pass. */
  checks: string[];
  /** The CI try limit. */
  tries: number;
  /** The review round limit. */
  rounds: number;
}

export interface ProfileOverride {
  profile: string;
  reason: string;
  by: "FLIGHT" | "planner";
}

export type ProfileRoute =
  | { by: "label"; label: string }
  | { by: "size"; size: string | null }
  | { by: "override"; from: string; who: "FLIGHT" | "planner"; reason: string };

export interface ChosenProfile {
  profile: Profile;
  route: ProfileRoute;
}

/** What a run keeps: the profile as it was when the run started, with its hash. */
export interface RunProfile extends ChosenProfile {
  hash: string;
}

const REVIEWER = "RETRO";

const checklist = (...lines: string[]): string => lines.map((l) => `- ${l}`).join("\n");

/** The built-ins, in routing order; a `profiles.yaml` replaces them whole. */
export const DEFAULT_PROFILES: readonly Profile[] = [
  {
    name: "feature",
    labels: ["type:feature"],
    steps: [
      { name: "plan", phase: null },
      { name: "go/no-go", phase: null },
      { name: "implement", phase: "working" },
      { name: "verify", phase: "ci" },
      { name: "review", phase: "review" },
      { name: "draft PR", phase: null },
    ],
    checklist: checklist(
      "Plan lists the acceptance criteria as a checklist verify can prove",
      "Every file in the plan sits inside the agent's area",
      "New test fails on the base commit (Mission Control re-runs it)",
      "The same test passes on the branch",
      "No existing test weakened, skipped or deleted",
      "Diff stays inside the area; no stray files",
    ),
    planRequired: true,
    reviewer: { role: REVIEWER, depth: "full" },
    checks: [],
    tries: 3,
    rounds: 3,
  },
  {
    name: "bugfix",
    labels: ["bug"],
    steps: [
      { name: "reproduce", phase: null },
      { name: "fix", phase: "working" },
      { name: "verify", phase: "ci" },
      { name: "review", phase: "review" },
      { name: "draft PR", phase: null },
    ],
    checklist: checklist(
      "A test reproduces the bug: fails on the base commit for the reported reason",
      "The reproducing test passes",
      "No stray files",
    ),
    planRequired: true,
    reviewer: { role: REVIEWER, depth: "full" },
    checks: [],
    tries: 3,
    rounds: 3,
  },
  {
    name: "small-change",
    labels: ["chore", "test", "docs"],
    steps: [
      { name: "implement", phase: "working" },
      { name: "verify", phase: "ci" },
      { name: "review", phase: "review" },
      { name: "draft PR", phase: null },
    ],
    checklist: checklist(
      "Only the paths this ticket type allows changed (tests for test, docs for docs)",
      "No existing test weakened, skipped or deleted",
    ),
    planRequired: false,
    reviewer: { role: REVIEWER, depth: "light" },
    checks: [],
    tries: 2,
    rounds: 2,
  },
  {
    name: "research",
    labels: ["research", "type:research"],
    steps: [
      { name: "investigate", phase: "working" },
      { name: "write-up", phase: null },
      { name: "review", phase: "review" },
    ],
    checklist: checklist(
      "Every claim cites a file, doc, URL or message",
      "One-line answer first, then the evidence",
    ),
    planRequired: false,
    reviewer: { role: REVIEWER, depth: "light" },
    checks: [],
    tries: 2,
    rounds: 2,
  },
  {
    name: "review",
    labels: [],
    steps: [
      { name: "read PR", phase: "working" },
      { name: "findings", phase: null },
      { name: "propose", phase: null },
    ],
    checklist: checklist(
      "Diff read against the ticket's intent",
      "Each finding has file:line and a failure scenario",
      "Comments wait for your approval; nothing posts on its own",
    ),
    planRequired: false,
    reviewer: { role: REVIEWER, depth: "light" },
    checks: [],
    tries: 1,
    rounds: 1,
  },
];

/** The profile a card with no template label falls back to, by Size. */
const fallbackName = (size: string | null): string =>
  size !== null && SMALL_SIZES.includes(size) ? "small-change" : "feature";

/**
 * Picks the profile for a card: the first in `ps` order with one of the card's labels, else
 * small-change at Size XS or S and feature otherwise. Throws if the fallback is missing (the
 * loader refuses a file without both).
 */
export function routeProfile(
  ps: readonly Profile[],
  labels: readonly string[],
  size: string | null,
): ChosenProfile {
  for (const profile of ps) {
    const label = profile.labels.find((l) => labels.includes(l));
    if (label !== undefined) return { profile, route: { by: "label", label } };
  }
  const name = fallbackName(size);
  const profile = ps.find((p) => p.name === name);
  if (profile === undefined) throw new Error(`no profile named "${name}"`);
  return { profile, route: { by: "size", size } };
}

/**
 * The override's profile, or null if `ps` has none of that name. It keeps every CI check the
 * routed profile required: its own checks, then the routed ones it lacks.
 */
export function overrideProfile(
  ps: readonly Profile[],
  routed: ChosenProfile,
  o: ProfileOverride,
): ChosenProfile | null {
  const profile = ps.find((p) => p.name === o.profile);
  if (profile === undefined) return null;
  const checks = [...profile.checks];
  for (const c of routed.profile.checks) if (!checks.includes(c)) checks.push(c);
  return {
    profile: { ...profile, checks },
    route: { by: "override", from: routed.profile.name, who: o.by, reason: o.reason },
  };
}

/** The step the run is on: the first whose phase is `phase`; null when parked or done. */
export function profileStep(p: Profile, phase: LoopPhase): string | null {
  if (phase === "parked" || phase === "done") return null;
  return p.steps.find((s) => s.phase === phase)?.name ?? null;
}

export const PROFILE_PAIR_TEXT = "profile and profile_reason go together: give both or neither";

export const unknownProfileText = (name: string, names: readonly string[]): string =>
  `Not started: no template profile is named "${name}"; the profiles are ${names.join(", ")}.`;
export const startNoProfilesText = (why: string): string =>
  `Not started: the template profiles in user config could not be read (${why}).`;
export const planUnknownProfileText = (name: string, names: readonly string[]): string =>
  `Not written: no template profile is named "${name}"; the profiles are ${names.join(", ")}. Call mc report_plan again with one of them, or without profile.`;
export const planNoProfilesText = (why: string): string =>
  `Not written: the template profiles in user config could not be read (${why}); call mc report_plan again without profile.`;

export const profileRouteText = (r: ProfileRoute): string => {
  if (r.by === "label") return `picked by the label ${r.label}`;
  if (r.by === "size") {
    return r.size === null
      ? "picked with no template label and no Size"
      : `picked by Size ${r.size}`;
  }
  return `chosen by ${r.who === "FLIGHT" ? "FLIGHT" : "the planner"} over ${r.from}: ${r.reason}`;
};
