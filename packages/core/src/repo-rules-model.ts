/** Shared data and helpers; independent of domain control flow. */

export const REPO_NEEDS = ["done_when", "size"] as const;

export type RepoNeed = (typeof REPO_NEEDS)[number];

export const HARD_RULES_BY = ["operator", "controller"] as const;

export type HardRulesBy = (typeof HARD_RULES_BY)[number];

export interface RepoRules {
  /** Explicit user-config keys, preserved across copies of these rules. */
  userSet?: readonly string[];
  /** Label to template mapping from the resolved repo rules. */
  templates?: Record<string, string>;
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
  /** Whether user config or the repo block set a `hard_rules` list (`[]` counts). */
  hardRulesSet: boolean;
  /** Who merges a PR that touches hard-rule files: the operator by hand, or the controller. */
  hardRulesBy: HardRulesBy | "flight";
  /** The open issue that collects minor findings from merged PRs, when this repo names one. */
  techDebtIssue?: number;
  alwaysAsk: string[];
  /**
   * The operator's acceptance (UAT) before merge: a passing PR whose ticket has one of `labels`, or
   * whose diff touches one of `paths`, waits for Accept or Send back. Both empty: no UAT.
   */
  uat: { labels: string[]; paths: string[] };
  /**
   * Exact shell commands a seat must have run, passing, on the head it pushes (`mc push` refuses
   * otherwise). Empty: the push is not gated.
   */
  checks: string[];
}
