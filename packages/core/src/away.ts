import type { FlightDecision, ReplyDraft } from "./flight.ts";
import { DEFAULT_PROFILES, SMALL_SIZES } from "./profiles.ts";
import { DEFAULT_HARD_RULES, type RepoRules } from "./repo-rules.ts";
import { globMatches } from "./runtime.ts";
import type { AttentionItem, AwaySettings, BoardItem, PullRequestView } from "./types.ts";

export const AWAY_SETTING = "away";
export const AWAY_WEEKLY_STOP_PCT = 70;
export const AWAY_WRITES_REFUSED =
  "Away mode is on: posting, merging and settings changes wait for the operator. Use draft_reply for messages.";
export const AWAY_START_REFUSED =
  "Away mode is on: automatic starts require Pick up safe tickets and an XS or S bug, chore, test or docs ticket.";
export const AWAY_QUOTA_REFUSED =
  "Away mode: the account has reached its quota stop or weekly reserve.";
export const AWAY_BUG_VERIFIED = "Reproducing test fails on the base and passes on the branch";
export const awayBugDecisionAbout = (ref: string, base: string, head: string): string =>
  `away-bug:${ref}:${base}:${head}`;

export const DEFAULT_TEMPLATE_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(DEFAULT_PROFILES.flatMap((p) => p.labels.map((l) => [l, p.name]))),
);
export type AwayTicketType = "bug" | "chore" | "test" | "docs";

/** A mapped small-change label with no narrower type is a chore. Conflicting types fail closed. */
export function awayTicketType(
  card: Pick<BoardItem, "size" | "labels">,
  templates: Readonly<Record<string, string>> = DEFAULT_TEMPLATE_LABELS,
): AwayTicketType | null {
  if (card.size === null || !SMALL_SIZES.includes(card.size)) return null;
  const types = new Set<AwayTicketType>();
  for (const label of card.labels) {
    const profile = Object.hasOwn(templates, label) ? templates[label] : undefined;
    if (profile === undefined) continue;
    if (profile === "bugfix") types.add("bug");
    else if (profile === "small-change") {
      const type = label.replace(/^type:/, "");
      types.add(type === "test" || type === "docs" ? type : "chore");
    } else return null;
  }
  return types.size === 1 ? ([...types][0] ?? null) : null;
}

/** Date-only settings include the named day in the operator's timezone. */
export function awayIsOn(settings: AwaySettings, now: number, timezone: string): boolean {
  if (!settings.on) return false;
  if (settings.until === "") return true;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return settings.until >= `${part("year")}-${part("month")}-${part("day")}`;
}

/** Manifests are held whole: dependency edits must not be hidden among other JSON changes. */
export const AWAY_UNSAFE_PATHS: readonly RegExp[] = [
  /(^|\/)(migrations?|settings?|config|configuration|ci|infra|infrastructure|terraform|auth|authentication|authorization|api)(\/|[._-]|$)/i,
  /(^|\/)(\.github|\.gitlab|\.circleci|\.buildkite|\.devcontainer)(\/|$)/i,
  /(^|\/)(package\.json|(package-lock|npm-shrinkwrap)\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]+\.lock|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.(mod|sum)|Gemfile|Dockerfile[^/]*|docker-compose[^/]*|compose\.ya?ml|Jenkinsfile)$/i,
  /\.(tf|tfvars)$/i,
];
export const AWAY_TEST_PATH =
  /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/i;
export const AWAY_DOC_PATH = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/i;
export interface AwayDiff {
  base: string;
  changes: { path: string; status: string }[];
}

export function awayDiffSafe(type: AwayTicketType, diff: AwayDiff, rules: RepoRules): boolean {
  return (
    diff.changes.length > 0 &&
    diff.changes.every(({ path, status }) => {
      if (!["A", "M", "D"].includes(status)) return false;
      if ([...DEFAULT_HARD_RULES, ...rules.hardRules].some((g) => globMatches(g, path, true)))
        return false;
      if (AWAY_UNSAFE_PATHS.some((p) => p.test(path))) return false;
      const test = AWAY_TEST_PATH.test(path);
      if (test && status !== "A") return false;
      if (type === "test" && !test) return false;
      if (type === "docs" && !AWAY_DOC_PATH.test(path)) return false;
      return true;
    })
  );
}

export interface AwayDigest {
  active: boolean;
  groups: [
    { kind: "needYouNow"; items: AttentionItem[] },
    { kind: "safePrsReady"; items: PullRequestView[] },
    { kind: "draftsToWalkThrough"; items: PullRequestView[] },
    { kind: "failures"; items: { runId: string; ticket: string | null; reason: string }[] },
    { kind: "flightDecisions"; items: FlightDecision[] },
    { kind: "messagesDrafted"; items: ReplyDraft[] },
  ];
}
