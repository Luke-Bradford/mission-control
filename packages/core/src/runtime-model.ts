/** Shared vocabulary and data shapes; independent of the domain algorithms. */

// What a crew process is started with: the CLI's tool allowlist (in `-p` mode anything not allowed
// is denied, spike 2026-10-20), the guard hook before every tool call, and the OS
// sandbox around every Bash, with `autoAllowBashIfSandboxed` off so the sandbox never widens the
// allowlist. The sandbox writes no git state: commits, pushes and PRs are the mc tools', made by
// the hub in its own clone.

/** A seat's role: a call sign, built in (`BUILTIN_ROLES`) or defined in config (`crew.roles`). */
export type CrewRole = string;

/** The modes a seat runs in; `scratch` = edits in its own throwaway worktree, no git writes, no PR. */
export const CREW_MODES = ["writer", "read-only", "scratch"] as const;

export type CrewMode = (typeof CREW_MODES)[number];

/**
 * What a role's loop does with its seat: builds tickets, reviews PRs, plans tickets, runs the crew
 * (`watch`, started with no ticket) or nothing.
 */
export const LOOP_KINDS = ["build", "review", "plan", "watch", "none"] as const;

export type LoopKind = (typeof LOOP_KINDS)[number];

export const SEAT_STATES = ["idle", "starting", "running", "parked", "stopped", "error"] as const;

export type SeatState = (typeof SEAT_STATES)[number];

/** The shell the Codex process environment and command approvals must name. */
export const CODEX_SHELL = "/bin/zsh";

/** The process protocol recorded with a crew run. */
export type CrewVendor = "claude" | "codex";
