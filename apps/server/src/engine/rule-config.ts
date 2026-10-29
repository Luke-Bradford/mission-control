/** The rule keys shared by user config and the optional repo block. */
import {
  DEFAULT_REPO_RULES,
  freezeRules,
  HARD_RULES_BY,
  REPO_NEEDS,
  type RepoRules,
} from "@mc/core";
import { z } from "zod";
import { protectedGlob } from "../globs.ts";

/**
 * A label glob: repo-relative, and `**` only as a trailing `/**`, else it would match wrongly
 * against seat globs.
 */
const labelGlob = z
  .string()
  .min(1)
  .refine((g) => !g.startsWith("/"), "must be repo-relative, not start with /")
  .refine((g) => !g.replace(/\/\*\*$/, "").includes("**"), "`**` only as a trailing /**");

const nonEmpty = z.string().min(1);
// One plain command: a check is matched whole against a seat's `&&` segment, so it holds no chaining.
const checkCommand = z
  .string()
  .trim()
  .min(1)
  .refine((c) => !/&&|[|;\n\r]/.test(c), "must be one plain command: no &&, |, ; or line break");
const issueNumber = z.number().int().positive().safe();
// `pick_from: []` is refused on purpose: pausing a repo is not this key's job. Status names are
// not checked against the board here; the engine reports a status it cannot find.
export const repoRulesSchema = z.strictObject({
  templates: z.record(nonEmpty, nonEmpty).optional(),
  pick_from: z.array(nonEmpty).min(1).optional(),
  promote_backlog: z.boolean().optional(),
  needs: z.array(z.enum(REPO_NEEDS)).optional(),
  areas: z
    .unknown()
    .refine(
      (v) => typeof v !== "object" || v === null || !Object.hasOwn(v, "__proto__"),
      'the label "__proto__" is not allowed',
    )
    .pipe(z.record(nonEmpty, z.array(labelGlob).min(1)))
    .optional(),
  // `null` inherits the base list; `[]` explicitly sets no paths.
  hard_rules: z.array(protectedGlob).nullable().optional(),
  hard_rules_by: z.enum(HARD_RULES_BY).optional(),
  tech_debt_issue: issueNumber.optional(),
  always_ask: z.array(nonEmpty).optional(),
  // exact commands, matched whole against a seat's shell call: see check-runs.ts
  checks: z.array(checkCommand).optional(),
});

/** Resolve user config over defaults; supplied maps and lists replace defaults. */
export function resolveRepoRules(r: z.infer<typeof repoRulesSchema>): RepoRules {
  const base = DEFAULT_REPO_RULES;
  return freezeRules({
    userSet: Object.keys(r).filter((key) => r[key as keyof typeof r] !== undefined),
    ...base,
    ...(r.templates === undefined ? {} : { templates: r.templates }),
    pickFrom: r.pick_from ?? base.pickFrom,
    promoteBacklog: r.promote_backlog ?? base.promoteBacklog,
    needs: r.needs ?? base.needs,
    areas: r.areas === undefined ? base.areas : Object.fromEntries(Object.entries(r.areas)),
    hardRules: r.hard_rules ?? base.hardRules,
    hardRulesSet: Array.isArray(r.hard_rules) || base.hardRulesSet,
    hardRulesBy: r.hard_rules_by ?? base.hardRulesBy,
    ...(r.tech_debt_issue === undefined ? {} : { techDebtIssue: r.tech_debt_issue }),
    alwaysAsk: r.always_ask ?? base.alwaysAsk,
    checks: r.checks ?? base.checks,
  });
}

/** A repo block can tighten safety rules and fill user-omitted policy keys. */
export function overlayRepoBlock(
  base: RepoRules,
  block: z.infer<typeof repoRulesSchema>,
): RepoRules {
  const keys = base.userSet;
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return freezeRules({
    ...base,
    ...(base.templates !== undefined || block.templates === undefined
      ? {}
      : { templates: block.templates }),
    promoteBacklog: keys?.includes("promote_backlog")
      ? base.promoteBacklog
      : (block.promote_backlog ?? base.promoteBacklog),
    needs: keys?.includes("needs") ? base.needs : (block.needs ?? base.needs),
    pickFrom: block.pick_from ?? base.pickFrom,
    areas: block.areas ?? base.areas,
    hardRules:
      block.hard_rules == null
        ? base.hardRules
        : base.hardRulesSet
          ? union(base.hardRules, block.hard_rules)
          : block.hard_rules,
    hardRulesSet: base.hardRulesSet || Array.isArray(block.hard_rules),
    hardRulesBy:
      base.hardRulesBy === "operator" || block.hard_rules_by === "operator"
        ? "operator"
        : (block.hard_rules_by ?? base.hardRulesBy),
    ...(base.techDebtIssue === undefined && block.tech_debt_issue === undefined
      ? {}
      : { techDebtIssue: base.techDebtIssue ?? block.tech_debt_issue }),
    alwaysAsk: union(base.alwaysAsk, block.always_ask ?? []),
    // a repo block can only add checks, never drop the user config's
    checks: union(base.checks, block.checks ?? []),
  });
}
