/**
 * Setup › Roles & guards: the repo rules the page lists, with where each value comes from. The
 * keys, groups and plain labels follow the approved mockup (`mockups/setup-roles-guards`); the
 * values come from one `RepoRulesView` per repo.
 */

export const RULE_SOURCES = [
  "set-here",
  "repo-file",
  "default",
  "config-file",
  "built-in",
] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

/** The badge for each source: its word, and what it means for the reader. */
export const SOURCE_TEXT: Record<RuleSource, { label: string; hint: string }> = {
  "set-here": { label: "Set here", hint: "Saved in config.yaml. Edit it here." },
  "repo-file": {
    label: "Repo file",
    hint: "Set in the repo's CLAUDE.md. Change it with a reviewed PR.",
  },
  default: {
    label: "Default",
    hint: "Mission Control's default. Edit it here to set your own.",
  },
  "config-file": {
    label: "Config file",
    hint: "Saved in config.yaml, but this page cannot change it. Edit the file.",
  },
  "built-in": { label: "Built in", hint: "Part of Mission Control's code." },
};

/** Where the repo file's value replaces a value the user set. */
export const REPO_FILE_WINS = "Repo file wins";
/** Why Authority is read-only. */
export const AUTHORITY_NOTE = "Only config.yaml sets this. A change restarts FLIGHT.";
/** Why every Edit is off until the write route exists. */
export const EDIT_SOON = "Saving these rules comes next.";

export const RULE_GROUPS = [
  {
    title: "Work the crew picks",
    rules: [
      { key: "pick_from", label: "Statuses the crew picks from" },
      { key: "needs", label: "A ticket must have" },
      { key: "areas", label: "Labels that name an area" },
      { key: "promote_backlog", label: "FLIGHT may promote Backlog tickets" },
    ],
  },
  {
    title: "Protected files",
    rules: [
      { key: "protected", label: "Files a seat may not change" },
      { key: "hard_rules", label: "Files that never auto-merge" },
      { key: "hard_rules_by", label: "Who may override them" },
    ],
  },
  {
    title: "Checks",
    rules: [
      { key: "commands.writer", label: "Commands a writer runs" },
      { key: "commands.review", label: "Commands a reviewer runs" },
      { key: "full_suite", label: "Commands that take the test lock" },
      { key: "required_checks", label: "CI checks a PR must pass" },
      { key: "checks", label: "Exact commands a PR must show run" },
    ],
  },
  {
    title: "Your approval",
    rules: [
      { key: "uat.labels", label: "Labels that wait for you" },
      { key: "uat.paths", label: "Paths that wait for you" },
      { key: "always_ask", label: "Decisions always brought to you" },
    ],
  },
  {
    title: "Authority",
    rules: [
      { key: "autonomy", label: "What the hub may do alone" },
      { key: "flight_powers", label: "What FLIGHT may do" },
    ],
  },
] as const;

export type RuleKey = (typeof RULE_GROUPS)[number]["rules"][number]["key"];

/** Keys this page never edits: only config.yaml sets them. */
export const READ_ONLY_RULES: ReadonlySet<RuleKey> = new Set<RuleKey>([
  "autonomy",
  "flight_powers",
]);

export interface RuleValue {
  source: RuleSource;
  /** What applies now: a list, or one word for an on/off or choice key. */
  value: string[];
  /** Values the repo file adds to a list the user also sets (shown dashed, never removable). */
  repoAdds?: string[];
}

/** One repo's rules and where each came from. */
export interface RepoRulesView {
  repoId: string;
  /** Whether the repo's CLAUDE.md holds a rules block. */
  repoFile: boolean;
  rules: Record<RuleKey, RuleValue>;
}
