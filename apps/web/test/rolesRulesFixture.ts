import { type RepoRulesView, RULE_GROUPS, type RuleKey } from "../src/setup/repoRules.ts";

const base = (): Record<RuleKey, RepoRulesView["rules"][RuleKey]> => {
  const out = {} as Record<RuleKey, RepoRulesView["rules"][RuleKey]>;
  for (const g of RULE_GROUPS)
    for (const r of g.rules) out[r.key] = { source: "default", value: [] };
  out.pick_from = { source: "repo-file", value: ["Ready", "In review"] };
  out.needs = { source: "default", value: ["done_when", "size"] };
  out.areas = {
    source: "repo-file",
    value: ["web: apps/web/**", "server: apps/server/**", "core: packages/core/**"],
  };
  out.promote_backlog = { source: "set-here", value: ["Off"] };
  out.protected = { source: "set-here", value: [".github/**", "config.example.yaml"] };
  out.hard_rules = {
    source: "default",
    value: ["loops/**", "roles/**", "CLAUDE.md", ".github/**"],
  };
  out.hard_rules_by = { source: "default", value: ["operator"] };
  out["commands.writer"] = { source: "set-here", value: ["pnpm -s lint", "pnpm -s typecheck"] };
  out.checks = {
    source: "set-here",
    value: ["pnpm -s lint"],
    repoAdds: ["pnpm -s typecheck", "pnpm -s test:related"],
  };
  out["uat.labels"] = { source: "set-here", value: ["needs-design"] };
  out.autonomy = { source: "config-file", value: ["draft"] };
  out.flight_powers = { source: "config-file", value: ["standard"] };
  return out;
};

/** One repo's rules as the read route will serve them: a spread of sources, one with repo additions. */
export const rulesFixture = (repoId: string): RepoRulesView => ({
  repoId,
  repoFile: true,
  rules: base(),
});
