/**
 * Template profiles: the mockup's templates (feature, bugfix, small-change, research, review) as
 * data the operator keeps in user config. A profile sets the steps shown, the checklist briefed,
 * whether a plan is required, the reviewer, the CI checks and the try and round limits. The file
 * reader is the server's; this is the shape, the built-ins, the routing and the texts.
 */
import type { LoopPhase } from "./types.ts";

/** What `/api/config` gives as the source when no profiles file exists and the built-ins apply. */
export const BUILTIN_PROFILES_SOURCE = "built-in";
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
export const FIX_STEP = "fix";

export const PROFILE_CHECK_KINDS = ["cmd", "rule", "review", "gate", "agent"] as const;
export interface ProfileStep {
  name: string;
  phase: ProfileStepPhase | null;
  role?: string;
  checks?: { kind: (typeof PROFILE_CHECK_KINDS)[number]; text: string }[];
  gate?: boolean;
  retry?: string;
  max?: number;
}

export interface Profile {
  trigger?: string;
  /** Catalogue token budget, for description only; execution keeps its configured budget. */
  budget?: number | null;
  /** Optional hard dollar cap passed to Claude for each run using this template. */
  budgetUsd?: number | null;
  orchestrationOnly?: boolean;
  nodes?: ProfileStep[];
  name: string;
  /** Card labels that pick this profile. */
  labels: string[];
  /** The steps to display; `phase` ties a step to the loop phase it is shown in. */
  steps: ProfileStep[];
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
const BUILD_PROFILES: readonly Profile[] = [
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
      "For an apps/web ticket, Design names the page question and every KPI's definition, window and unit",
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
      { name: FIX_STEP, phase: "working" },
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

const DESCRIPTIONS: {
  name: string;
  trigger: string;
  budget: number | null;
  rounds: number;
  steps: string[];
  nodes: ProfileStep[];
}[] = [
  {
    name: "feature",
    trigger: "label type:feature",
    budget: 400000,
    rounds: 3,
    steps: ["plan", "go/no-go", "implement", "verify", "review", "draft PR"],
    nodes: [
      {
        name: "plan",
        phase: null,
        role: "FIDO, or the assigned GUIDO",
        checks: [
          {
            kind: "review",
            text: "Plan lists the acceptance criteria as a checklist verify can prove",
          },
          {
            kind: "rule",
            text: "Every file in the plan sits inside the agent's area",
          },
        ],
      },
      {
        name: "go/no-go",
        phase: null,
        role: "FLIGHT polls, you decide",
        checks: [
          {
            kind: "gate",
            text: "FLIGHT polls every check; you make the call",
          },
        ],
        gate: true,
        retry: "no-go → back to plan",
      },
      {
        name: "implement",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "New test fails on the base commit (Mission Control re-runs it)",
          },
          {
            kind: "cmd",
            text: "The same test passes on the branch",
          },
        ],
      },
      {
        name: "draft PR",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "rule",
            text: "PR is open as a draft",
          },
          {
            kind: "rule",
            text: "Body lists the deploy steps",
          },
        ],
      },
      {
        name: "review",
        phase: null,
        role: "RETRO, fresh eyes: sees the ticket, plan, diff and check output, not the author's chat",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
        retry: "Critical or Important findings → fix → verify",
      },
      {
        name: "verify",
        phase: null,
        role: "Mission Control runs it",
        checks: [
          {
            kind: "cmd",
            text: "Full test suite passes (takes the test lock)",
          },
          {
            kind: "cmd",
            text: "Typecheck exits 0",
          },
          {
            kind: "rule",
            text: "No existing test weakened, skipped or deleted",
          },
          {
            kind: "rule",
            text: "Diff stays inside the area; no stray files",
          },
        ],
        max: 3,
        retry: "fail → fix → back to verify · max 3",
      },
      {
        name: "fix",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "agent",
            text: "Each finding has a commit or a written ruling",
          },
        ],
      },
    ],
  },
  {
    name: "bugfix",
    trigger: "label bug",
    budget: 250000,
    rounds: 3,
    steps: ["reproduce", "fix", "verify", "review", "draft PR"],
    nodes: [
      {
        name: "reproduce",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "A test reproduces the bug: fails on the base commit for the reported reason",
          },
        ],
      },
      {
        name: "fix",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "The reproducing test passes",
          },
        ],
      },
      {
        name: "verify",
        phase: null,
        role: "Mission Control runs it",
        checks: [
          {
            kind: "cmd",
            text: "Full test suite passes (takes the test lock)",
          },
          {
            kind: "cmd",
            text: "Typecheck exits 0",
          },
          {
            kind: "rule",
            text: "No stray files",
          },
        ],
        max: 3,
        retry: "fail → fix → back to verify · max 3",
      },
      {
        name: "draft PR",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "rule",
            text: "PR is open as a draft",
          },
        ],
      },
      {
        name: "review",
        phase: null,
        role: "RETRO, fresh eyes: sees the ticket, plan, diff and check output, not the author's chat",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
        retry: "Critical or Important findings → fix → verify",
      },
    ],
  },
  {
    name: "small-change",
    trigger: "chore, test or docs ticket",
    budget: 120000,
    rounds: 2,
    steps: ["implement", "verify", "review", "draft PR"],
    nodes: [
      {
        name: "implement",
        phase: null,
        role: "GUIDO or INCO",
        checks: [
          {
            kind: "rule",
            text: "Only the paths this ticket type allows changed (tests for test, docs for docs)",
          },
        ],
      },
      {
        name: "verify",
        phase: null,
        role: "Mission Control runs it",
        checks: [
          {
            kind: "cmd",
            text: "Full test suite passes (takes the test lock)",
          },
          {
            kind: "rule",
            text: "No existing test weakened, skipped or deleted",
          },
        ],
        max: 2,
        retry: "fail → back to implement · max 2",
      },
      {
        name: "review",
        phase: null,
        role: "RETRO, fresh eyes",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
        retry: "Critical or Important findings → implement → verify",
      },
      {
        name: "draft PR",
        phase: null,
        role: "GUIDO or INCO",
        checks: [
          {
            kind: "rule",
            text: "PR is open as a draft",
          },
        ],
      },
    ],
  },
  {
    name: "research",
    trigger: "label research",
    budget: 150000,
    rounds: 2,
    steps: ["investigate", "write-up", "review"],
    nodes: [
      {
        name: "investigate",
        phase: null,
        role: "NETWORK",
        checks: [
          {
            kind: "agent",
            text: "Every claim cites a file, doc, URL or message",
          },
        ],
      },
      {
        name: "write-up",
        phase: null,
        role: "NETWORK",
        checks: [
          {
            kind: "agent",
            text: "One-line answer first, then the evidence",
          },
        ],
      },
      {
        name: "review",
        phase: null,
        role: "RETRO (hand-off)",
        checks: [
          {
            kind: "review",
            text: "A second agent re-checked each citation",
          },
        ],
        retry: "gaps → write-up again",
      },
    ],
  },
  {
    name: "review",
    trigger: "PR opened in a lane",
    budget: 120000,
    rounds: 1,
    steps: ["read PR", "findings", "propose"],
    nodes: [
      {
        name: "read PR",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "agent",
            text: "Diff read against the ticket's intent",
          },
        ],
      },
      {
        name: "findings",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "agent",
            text: "Each finding has file:line and a failure scenario",
          },
        ],
      },
      {
        name: "propose",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "gate",
            text: "Comments wait for your approval; nothing posts on its own",
          },
        ],
      },
    ],
  },
  {
    name: "tiger-team",
    trigger: "FLIGHT or you, for a blocker or a big ticket",
    budget: 600000,
    rounds: 2,
    steps: ["split", "work ×N", "verify each", "combine", "review"],
    nodes: [
      {
        name: "split",
        phase: null,
        role: "FLIGHT",
        checks: [
          {
            kind: "rule",
            text: "Sub-tasks have areas that don't overlap",
          },
        ],
      },
      {
        name: "work ×N",
        phase: null,
        role: "GUIDO ×N in parallel",
        checks: [
          {
            kind: "cmd",
            text: "Each sub-task's scoped tests pass",
          },
        ],
        retry: "runs in parallel, one sub-task per agent",
      },
      {
        name: "verify each",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "review",
            text: "A verifier confirms each result",
          },
        ],
        max: 2,
        retry: "fail → that sub-task again · max 2",
      },
      {
        name: "combine",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "Combined branch passes the full suite (takes the test lock)",
          },
        ],
      },
      {
        name: "review",
        phase: null,
        role: "RETRO, fresh eyes",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
        retry: "findings → fix the combined branch",
      },
    ],
  },
  {
    name: "watch",
    trigger: "every 10 min",
    budget: null,
    rounds: 0,
    steps: ["poll", "triage", "assign"],
    nodes: [
      {
        name: "poll",
        phase: null,
        role: "Mission Control",
        checks: [
          {
            kind: "rule",
            text: "Board reachable; new or changed tickets listed",
          },
        ],
      },
      {
        name: "triage",
        phase: null,
        role: "FLIGHT",
        checks: [
          {
            kind: "agent",
            text: "Each ticket matched to a lane and a template",
          },
        ],
      },
      {
        name: "assign",
        phase: null,
        role: "FLIGHT",
        checks: [
          {
            kind: "gate",
            text: "Starting an agent waits for you unless auto-approved",
          },
        ],
        retry: "then poll again in 10 min",
      },
    ],
  },
];

/** Description metadata never supplies execution policy. */
export const DEFAULT_PROFILES: readonly Profile[] = DESCRIPTIONS.map((d) => {
  const build = BUILD_PROFILES.find((p) => p.name === d.name);
  const nodes = d.nodes.filter(
    (n) => d.name !== "feature" || !["plan", "go/no-go"].includes(n.name),
  );
  let path = d.steps.filter((n) => d.name !== "feature" || !["plan", "go/no-go"].includes(n));
  if (["feature", "bugfix", "small-change"].includes(d.name)) {
    path = [
      ...path.filter((n) => !["draft PR", "verify", "review"].includes(n)),
      "draft PR",
      "verify",
      "review",
      "merge",
    ];
    nodes.push({ name: "merge", phase: null, role: "Mission Control", checks: [] });
  }
  const decorate = (name: string): ProfileStep => ({
    ...nodes.find((n) => n.name === name),
    name,
    phase: build?.steps.find((s) => s.name === name)?.phase ?? null,
  });
  return {
    ...(build ?? {
      name: d.name,
      labels: [],
      checklist: "",
      planRequired: false,
      reviewer: { role: "RETRO", depth: "light" as const },
      checks: [],
      tries: 2,
      rounds: d.rounds,
    }),
    trigger: d.trigger,
    budget: d.budget,
    orchestrationOnly: !build,
    steps: path.map(decorate),
    nodes: nodes.map((n) => decorate(n.name)),
  };
});

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
    if (profile.orchestrationOnly) continue;
    const label = profile.labels.find((l) => labels.includes(l));
    if (label !== undefined) return { profile, route: { by: "label", label } };
  }
  const name = fallbackName(size);
  const profile = ps.find((p) => p.name === name && !p.orchestrationOnly);
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
  if (profile === undefined || profile.orchestrationOnly) return null;
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
