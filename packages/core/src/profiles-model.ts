/** Shared vocabulary and data shapes; independent of the domain algorithms. */

export const PROFILE_STEP_PHASES = ["working", "ci", "review"] as const;

export type ProfileStepPhase = (typeof PROFILE_STEP_PHASES)[number];

export const REVIEW_DEPTHS = ["light", "full"] as const;

export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];

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
