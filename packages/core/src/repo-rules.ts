/**
 * A repo's board rules, read from the `## Mission Control` section of its `CLAUDE.md`: which
 * statuses a seat may pick from, which area labels match a seat, and which paths are hard-rule
 * files. The parser is the server's; this is the shape, the defaults and the label match.
 */
import {
  claimedText,
  hasDoneWhenSection,
  hasPlanSection,
  noAreaText,
  otherLaneText,
  PLAN_SIZES,
  researchText,
  startClosedText,
  startMissingNeedsText,
  startNeedsPlanText,
  ticketHasRunText,
  twoAreasText,
  waitsOnText,
  wrongAreaText,
} from "./flight.ts";
import { hudColumnOf } from "./hud.ts";
import { type LoopKind, pathInArea } from "./runtime.ts";
import type { BoardItem } from "./types.ts";

export const REPO_NEEDS = ["done_when", "size"] as const;
export type RepoNeed = (typeof REPO_NEEDS)[number];

export const HARD_RULES_BY = ["operator", "controller"] as const;
export type HardRulesBy = (typeof HARD_RULES_BY)[number];

export interface RepoRules {
  /** Board statuses a seat may pick a ticket from. */
  pickFrom: string[];
  /** Whether the hub may promote Backlog tickets to a pickable status. */
  promoteBacklog: boolean;
  /** What makes a Backlog ticket complete enough to promote to Ready. */
  needs: RepoNeed[];
  /** Area label → the globs it covers. */
  areas: Record<string, string[]>;
  /** Globs of files that need the operator's sign-off. */
  hardRules: string[];
  /** Whether the repo's block set `hard_rules` itself (`[]` counts); false on the defaults. */
  hardRulesSet: boolean;
  /** Who merges a PR that touches hard-rule files: the operator by hand, or the controller. */
  hardRulesBy: HardRulesBy;
  alwaysAsk: string[];
}

/**
 * Freezes `rules` and everything inside it, so a caller cannot corrupt the shared defaults or a
 * cached result. The type stays mutable: the freeze is the runtime guard.
 */
export function freezeRules(rules: RepoRules): RepoRules {
  for (const globs of Object.values(rules.areas)) Object.freeze(globs);
  Object.freeze(rules.areas);
  Object.freeze(rules.pickFrom);
  Object.freeze(rules.needs);
  Object.freeze(rules.hardRules);
  Object.freeze(rules.alwaysAsk);
  return Object.freeze(rules);
}

/** The Needs you note for a `merge` repo whose rules leave `hard_rules` unset: one per repo. */
export const hardRulesUnsetNoteKey = (repoId: string): string => `hard-rules-unset:${repoId}`;

/** The settings key under which the engine keeps a repo's last good `hard_rules_by`. */
export const hardRulesBySettingKey = (repoId: string): string => `hard_rules_by:${repoId}`;

export const hardRulesUnsetText = (repo: string): string =>
  `${repo}: set \`hard_rules\` in the repo's Mission Control block (a list of paths that never auto-merge, or \`[]\`) before the hub merges there.`;

export const DEFAULT_HARD_RULES: string[] = Object.freeze([
  "apps/server/src/guard/**",
  "apps/server/src/mcp/**",
  "apps/server/src/runtime/**",
  "apps/server/src/engine/**",
  "apps/server/src/flight/**",
  "packages/core/src/guard.ts",
  "packages/core/src/flight.ts",
  "packages/core/src/loop.ts",
  "packages/core/src/review.ts",
  "packages/core/src/repo-rules.ts",
  "packages/core/src/runtime.ts",
  "loops/**",
  "roles/**",
  "CLAUDE.md",
  ".github/**",
  "config.example.yaml",
]) as string[];

export const DEFAULT_REPO_RULES: RepoRules = freezeRules({
  pickFrom: ["Ready"],
  promoteBacklog: false,
  needs: [...REPO_NEEDS],
  areas: {},
  hardRules: DEFAULT_HARD_RULES,
  hardRulesSet: false,
  hardRulesBy: "operator",
  alwaysAsk: [],
});

/**
 * The area labels that match a seat, in `areas` order. A seat area of `[]` (the whole checkout)
 * matches every label; otherwise a label matches when each of its globs, with a trailing `/**`
 * cut to `/`, is a path the seat's area accepts (`apps/server/` is in `apps/server/**`; the bare
 * `apps/server` would not be, as `globMatches` wants the slash after a `/**` folder).
 */
export function areaLabelsFor(rules: Pick<RepoRules, "areas">, seatArea: string[]): string[] {
  return Object.entries(rules.areas)
    .filter(
      ([, globs]) =>
        globs.length > 0 &&
        (seatArea.length === 0 ||
          globs.every((g) => pathInArea(seatArea, g.replace(/\/\*\*$/, "/")))),
    )
    .map(([label]) => label);
}

/** The lanes a hub can be told to start; a card carries one as a `lane:<lane>` label. */
export const CREW_LANES = ["home", "work"] as const;
export type CrewLane = (typeof CREW_LANES)[number];

/** A research ticket is never taken by rule; `type:research` is the label the setup creates. */
export const RESEARCH_LABELS: readonly string[] = ["research", "type:research"];

/** The area labels (those the rules name) on a card. */
export const areaLabelsOf = (
  rules: Pick<RepoRules, "areas">,
  card: Pick<BoardItem, "labels">,
): string[] => card.labels.filter((l) => Object.hasOwn(rules.areas, l));

/** Whether the card is assigned to a login other than the hub's own (any login, when the hub's is unknown). */
export const claimedByOther = (card: Pick<BoardItem, "assignees">, login: string | null): boolean =>
  (card.assignees ?? []).some((a) => a !== login);

/** The issues a ticket body names on its `Depends on` lines, in order, without repeats. */
export function dependsOn(body: string): number[] {
  const out: number[] = [];
  for (const line of body.match(/^.*\bDepends on\b.*$/gim) ?? []) {
    for (const m of line.matchAll(/#(\d+)/g)) {
      const n = Number(m[1]);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

const LANE_PREFIX = "lane:";

/**
 * Whether a hub on `lane` starts a card with these labels: any card when the hub has no lane;
 * else one whose only `lane:` label is its own, or, on the default-lane hub, one with none.
 */
export function inLane(
  labels: readonly string[],
  lane: CrewLane | undefined,
  laneDefault: boolean,
): boolean {
  if (lane === undefined) return true;
  const own = labels.filter((l) => l.startsWith(LANE_PREFIX));
  return (
    (own.length === 1 && own[0] === `${LANE_PREFIX}${lane}`) || (own.length === 0 && laneDefault)
  );
}

export interface StartCheck {
  repoId: string;
  issue: number;
  card: Pick<
    BoardItem,
    "labels" | "assignees" | "blockedBy" | "size" | "status" | "state" | "closed"
  >;
  rules: Pick<RepoRules, "areas" | "needs">;
  seat: { call: string; area: string[]; loop: LoopKind };
  login: string | null;
  hasRun: boolean;
  lane: CrewLane | undefined;
  laneDefault: boolean;
  /** The ticket body; null skips the checks that read it. */
  body: string | null;
  closed: (issue: number) => boolean | undefined;
}

/**
 * The one check every way a run starts applies (the queue, a hand Start, FLIGHT's start_seat):
 * the first reason the seat may not start the ticket, or null.
 */
export function eligibleToStart(c: StartCheck): string | null {
  const { card, rules, seat, body } = c;
  const ref = `${c.repoId}#${c.issue}`;
  // work that has landed is not started again, whatever path asked
  if (hudColumnOf(card) === "Done") return startClosedText(ref);
  if (c.lane !== undefined && !inLane(card.labels, c.lane, c.laneDefault)) {
    const laneLabels = card.labels.filter((l) => l.startsWith(LANE_PREFIX));
    return otherLaneText(ref, laneLabels, c.lane);
  }
  const areas = areaLabelsOf(rules, card);
  if (areas.length >= 2) return twoAreasText(ref, areas);
  const area = areas[0];
  if (area === undefined && Object.keys(rules.areas).length > 0) return noAreaText(ref);
  if (area !== undefined && !areaLabelsFor(rules, seat.area).includes(area)) {
    return wrongAreaText(seat.call, ref, areas);
  }
  if (c.hasRun) return ticketHasRunText(ref);
  if (claimedByOther(card, c.login)) {
    return claimedText(
      ref,
      (card.assignees ?? []).filter((a) => a !== c.login),
    );
  }
  const waits = new Set(card.blockedBy.filter((b) => !b.closed).map((b) => b.ref));
  if (body !== null) {
    for (const n of dependsOn(body)) if (c.closed(n) !== true) waits.add(`${c.repoId}#${n}`);
  }
  if (waits.size > 0) return waitsOnText(ref, [...waits]);
  const build = seat.loop === "build";
  if (build && card.labels.some((l) => RESEARCH_LABELS.includes(l))) return researchText(ref);
  if (body === null) return null;
  if (build || seat.loop === "plan") {
    const missing = rules.needs.filter((n) =>
      n === "done_when" ? !hasDoneWhenSection(body) : card.size === null,
    );
    if (missing.length > 0) return startMissingNeedsText(ref, missing);
  }
  if (build && card.size !== null && PLAN_SIZES.includes(card.size) && !hasPlanSection(body)) {
    return startNeedsPlanText(ref, card.size);
  }
  return null;
}
