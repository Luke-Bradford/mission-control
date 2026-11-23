import type { RepoRuleSource, RepoRulesView } from "@mc/core";

/**
 * Setup › Roles & guards: the repo rules the page lists, with where each value comes from. The
 * keys, groups and plain labels follow the approved mockup (`mockups/setup-roles-guards`); the
 * values come from one `RepoRulesView` per repo.
 */

export type RuleSource = RepoRuleSource;

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
export const AUTHORITY_NOTE = "Set on Repos & seats.";

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

/** One rule's value as the chips show it: a list, or one word for an on/off or choice key. */
export function ruleChips(view: RepoRulesView, key: RuleKey): string[] {
  const value: unknown = view.rules[key].value;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "boolean") return [value ? "On" : "Off"];
  if (typeof value === "object" && value !== null)
    return Object.entries(value).map(([name, globs]) =>
      Array.isArray(globs) ? `${name}: ${globs.join(", ")}` : name,
    );
  return value === undefined || value === null ? [] : [String(value)];
}

/** A rule's current value as the editor's text: lines, `label: glob, glob` lines, or one word. */
export function ruleDraft(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("\n");
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object" && value !== null)
    return Object.entries(value)
      .map(([name, globs]) => `${name}: ${Array.isArray(globs) ? globs.join(", ") : ""}`)
      .join("\n");
  return value === undefined || value === null ? "" : String(value);
}

/** The editor's text back as the value the route takes. */
export function ruleValue(key: RuleKey, current: unknown, text: string): unknown {
  if (typeof current === "boolean") return text === "true";
  if (key === "areas")
    return Object.fromEntries(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf(":");
          return [
            line.slice(0, at).trim(),
            line
              .slice(at + 1)
              .split(",")
              .map((g) => g.trim())
              .filter(Boolean),
          ];
        }),
    );
  if (key === "hard_rules_by") return text;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `commands.*` and `uat.*` send one leaf; every other rule sends itself. */
export function ruleBody(key: RuleKey, value: unknown): Record<string, unknown> {
  const dot = key.indexOf(".");
  return dot < 0 ? { [key]: value } : { [key.slice(0, dot)]: { [key.slice(dot + 1)]: value } };
}
