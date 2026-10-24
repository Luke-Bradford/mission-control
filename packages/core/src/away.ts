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
  "Away mode: starting work requires current quota readings below the account stop and 70% weekly reserve.";
export const AWAY_PLANNER_REFUSED =
  "Away mode: planner starts wait for the operator because plans edit GitHub issues.";
export const AWAY_PLAN_REFUSED =
  "Away mode: the plan cannot be written to the GitHub issue. Report it again when the operator returns.";
export const AWAY_BUG_PROFILE = "bugfix";
export const AWAY_SMALL_PROFILE = "small-change";
export const AWAY_TYPE_PREFIX = /^type:/;
export const AWAY_STATUS_ADDED = "A";
export const AWAY_DIFF_STATUSES = [AWAY_STATUS_ADDED, "M", "D"];
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
    if (profile === AWAY_BUG_PROFILE) types.add("bug");
    else if (profile === AWAY_SMALL_PROFILE) {
      const type = label.replace(AWAY_TYPE_PREFIX, "");
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
  /\.(tf|tfvars|plist|csproj)$/i,
  /(^|[/._-])(config|ci|settings?|migrat\w*|auth\w*|oauth|session|secrets?|credentials?|env|permissions?|tokens?|login|guard|middleware)([/._-]|$)/i,
  /(^|\/)[^/]*\.config\.[^/]+$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /^\.[^/]+(?:\/|$)/,
  /(^|\/)(\.husky|\.claude)(\/|$)/i,
  /(^|\/)(CLAUDE\.md|AGENTS\.md|\.mcp\.json|\.npmrc|pnpm-workspace\.yaml|setup\.(py|cfg)|Pipfile|Directory\.Packages\.props|pom\.xml|build\.gradle[^/]*|openapi\.[^/]+|schema\.sql|Makefile|biome\.json|turbo\.json|azure-pipelines\.ya?ml|Procfile|netlify\.toml|vercel\.json|fly\.toml|wrangler\.toml|app\.yaml|serverless\.yml|conftest\.py|pytest\.ini|tox\.ini|noxfile\.py|justfile|Taskfile\.yml|requirements\.in|environment\.yml|Brewfile|CODEOWNERS)$/i,
  /(^|\/)[^/]+\.setup\.[^/]*(js|ts)$/i,
  /(^|\/)(k8s|helm|charts)(\/|$)/i,
  /(^|\/)(alembic|ops)(\/|$)|(^|\/)db\/migrate\//i,
  // This repo's GitHub-write wiring is unsafe even when a repo omits hard rules.
  /^apps\/server\/src\/(store|main|collectors\/github|github-board|claim|accounts)\.ts$/,
  /^scripts\/(deploy|release|install|postinstall)[^/]*$/i,
];
/** A spec document is documentation, never a test. Helpers alone are not test evidence. */
export const AWAY_TEST_PATH = /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/i;
export const AWAY_TEST_DIR = /(^|\/)(__tests__|tests?|specs?)\//i;
export const AWAY_FIXTURE_DIR = /(^|\/)fixtures\//i;
export const AWAY_DOC_PATH = /(^|\/)README[^/]*$|\.(md|mdx|rst|txt|png|jpe?g|svg|gif)$/i;
export const AWAY_DOC_EXCLUDED = /^(\.claude|roles|loops)\//i;
export const awayTestPath = (path: string): boolean =>
  !AWAY_DOC_PATH.test(path) && (AWAY_TEST_PATH.test(path) || AWAY_FIXTURE_DIR.test(path));
export interface AwayDiff {
  base: string;
  changes: { path: string; status: string }[];
}

export function awayDiffSafe(
  type: AwayTicketType,
  diff: AwayDiff,
  rules: RepoRules,
  area: readonly string[],
): boolean {
  return (
    area.length > 0 &&
    diff.changes.length > 0 &&
    diff.changes.every(({ path, status }) => {
      if (!AWAY_DIFF_STATUSES.includes(status)) return false;
      if (!area.some((g) => globMatches(g, path))) return false;
      if ([...DEFAULT_HARD_RULES, ...rules.hardRules].some((g) => globMatches(g, path, true)))
        return false;
      if (AWAY_UNSAFE_PATHS.some((p) => p.test(path))) return false;
      const test = awayTestPath(path);
      const protectsTests = test || (!AWAY_DOC_PATH.test(path) && AWAY_TEST_DIR.test(path));
      if (protectsTests && status !== AWAY_STATUS_ADDED) return false;
      if (type === "test" && !test) return false;
      if (type === "docs" && (!AWAY_DOC_PATH.test(path) || AWAY_DOC_EXCLUDED.test(path)))
        return false;
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
