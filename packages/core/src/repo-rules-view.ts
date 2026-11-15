/** Where the Roles & guards view gets one displayed rule. */
export type RepoRuleSource = "set-here" | "repo-file" | "default" | "config-file" | "built-in";

export interface RepoRuleView {
  value: unknown;
  source: RepoRuleSource;
}

/** The editable and read-only rule values for one configured repository. */
export interface RepoRulesView {
  /** SHA-256 of config.yaml when the page read its rules. */
  base: string;
  rules: Record<string, RepoRuleView>;
}
