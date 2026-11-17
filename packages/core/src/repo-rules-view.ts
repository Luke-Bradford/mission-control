/** Where the Roles & guards view gets one displayed rule. */
export type RepoRuleSource = "set-here" | "repo-file" | "default" | "config-file" | "built-in";

export interface RepoRuleView<T> {
  value: T;
  source: RepoRuleSource;
  /**
   * Only on the keys the repo file adds to (`hard_rules` when set here, `checks`, `uat.*`,
   * `always_ask`): what its block adds beyond `value`, which stays the editable list.
   */
  repoAdds?: string[];
}

/** The keys the Roles & guards page edits, in the page's order. */
export const REPO_RULE_EDITABLE_KEYS = [
  "pick_from",
  "needs",
  "areas",
  "promote_backlog",
  "protected",
  "hard_rules",
  "hard_rules_by",
  "commands.writer",
  "commands.review",
  "full_suite",
  "required_checks",
  "checks",
  "uat.labels",
  "uat.paths",
  "always_ask",
] as const;

/** Read-only on the page: only config.yaml sets them. */
export const REPO_RULE_AUTHORITY_KEYS = ["autonomy", "flight_powers"] as const;

/** The editable and read-only rule values for one configured repository. */
export interface RepoRulesView {
  /** SHA-256 of the config.yaml bytes every value here was read from. */
  base: string;
  /** Why the repo file's rules are not shown, when its block could not be read. */
  repoFileError?: string;
  rules: {
    pick_from: RepoRuleView<string[]>;
    needs: RepoRuleView<string[]>;
    areas: RepoRuleView<Record<string, string[]>>;
    promote_backlog: RepoRuleView<boolean>;
    protected: RepoRuleView<string[]>;
    hard_rules: RepoRuleView<string[]>;
    hard_rules_by: RepoRuleView<string>;
    "commands.writer": RepoRuleView<string[]>;
    "commands.review": RepoRuleView<string[]>;
    full_suite: RepoRuleView<string[]>;
    required_checks: RepoRuleView<string[]>;
    checks: RepoRuleView<string[]>;
    "uat.labels": RepoRuleView<string[]>;
    "uat.paths": RepoRuleView<string[]>;
    always_ask: RepoRuleView<string[]>;
    autonomy: RepoRuleView<string>;
    flight_powers: RepoRuleView<string>;
  };
}
