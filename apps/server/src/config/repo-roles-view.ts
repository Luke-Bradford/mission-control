/**
 * What Setup › Roles & guards shows for one repo: each key's value and where it came from.
 * Sources follow `engine/rule-config.ts`'s `overlayRepoBlock`, key by key: the repo file replaces
 * `pick_from` and `areas`, fills `needs` and `promote_backlog` (and `hard_rules`) when config.yaml
 * leaves them out, tightens `hard_rules_by`, and only adds to `hard_rules` (when set here),
 * `checks`, `uat.*` and `always_ask`. A source is decided by who declared the key, never by
 * comparing values: a repo file that repeats a config value still owns it where it replaces.
 */
import {
  DEFAULT_REPO_RULES,
  type RepoRuleSource,
  type RepoRulesView,
  type RepoRuleView,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { defaultCommandsFor } from "../config.ts";
import { overlayRepoBlock, type RepoBlock } from "../engine/rule-config.ts";

type ConfigRepo = CcConfig["repos"][number];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** `repoFile` is the block read at origin/HEAD; an error string means it could not be read. */
export function repoRulesView(input: {
  base: string;
  repo: ConfigRepo;
  raw: Record<string, unknown>;
  repoFile: RepoBlock | null | string;
  /** Whether the hub's own files live in this repo (`ownsHubFiles`); false: its commands default to its checks. */
  ownsHub: boolean;
}): RepoRulesView {
  const { repo, raw } = input;
  const block = typeof input.repoFile === "string" ? null : input.repoFile;
  const configured = repo.rules ?? DEFAULT_REPO_RULES;
  const effective = block === null ? configured : overlayRepoBlock(configured, block);
  const rawRules = record(raw.rules);
  const rawUat = record(rawRules.uat);
  const set = (value: unknown) => value !== undefined && value !== null;
  const own = (isSet: boolean): RepoRuleSource => (isSet ? "set-here" : "default");
  const plain = <T>(value: T, isSet: boolean): RepoRuleView<T> => ({ value, source: own(isSet) });
  const replaced = <T>(value: T, key: keyof RepoBlock): RepoRuleView<T> => ({
    value,
    source: block?.[key] !== undefined ? "repo-file" : own(set(rawRules[key])),
  });
  const filled = <T>(
    value: T,
    key: "needs" | "promote_backlog" | "plan_signoff",
  ): RepoRuleView<T> => ({
    value,
    source: set(rawRules[key]) ? "set-here" : block?.[key] !== undefined ? "repo-file" : "default",
  });
  const added = (
    value: string[],
    isSet: boolean,
    declared: readonly string[] | null | undefined,
  ): RepoRuleView<string[]> => ({
    value,
    source: own(isSet),
    repoAdds: (declared ?? []).filter((item) => !value.includes(item)),
  });
  const hardRulesSet = Array.isArray(rawRules.hard_rules);
  const blockHardRules = Array.isArray(block?.hard_rules) ? block.hard_rules : null;
  const hardRules: RepoRuleView<string[]> = hardRulesSet
    ? added(configured.hardRules, true, blockHardRules)
    : blockHardRules !== null
      ? { value: effective.hardRules, source: "repo-file" }
      : plain(configured.hardRules, false);
  const tightened = configured.hardRulesBy !== "operator" && block?.hard_rules_by === "operator";
  const hardRulesBy: RepoRuleView<string> = tightened
    ? { value: effective.hardRulesBy, source: "repo-file" }
    : plain(configured.hardRulesBy, set(rawRules.hard_rules_by));
  const commandsSet = set(raw.commands);
  const commands = repo.commands ?? defaultCommandsFor(input.ownsHub, effective.checks);
  return {
    base: input.base,
    ...(typeof input.repoFile === "string" ? { repoFileError: input.repoFile } : {}),
    rules: {
      pick_from: replaced(effective.pickFrom, "pick_from"),
      needs: filled(effective.needs, "needs"),
      areas: replaced(effective.areas, "areas"),
      promote_backlog: filled(effective.promoteBacklog, "promote_backlog"),
      plan_signoff: filled(effective.planSignoff ?? "never", "plan_signoff"),
      protected: plain(repo.protectedFiles ?? [], set(raw.protected)),
      hard_rules: hardRules,
      hard_rules_by: hardRulesBy,
      "commands.writer": plain([...commands.writer], commandsSet),
      "commands.review": plain([...commands.review], commandsSet),
      full_suite: plain(repo.fullSuite ?? [], set(raw.full_suite)),
      required_checks: plain(repo.requiredChecks ?? [], set(raw.required_checks)),
      checks: added(configured.checks, set(rawRules.checks), block?.checks),
      "uat.labels": added(configured.uat.labels, set(rawUat.labels), block?.uat?.labels),
      "uat.paths": added(configured.uat.paths, set(rawUat.paths), block?.uat?.paths),
      always_ask: added(configured.alwaysAsk, set(rawRules.always_ask), block?.always_ask),
      autonomy: { value: repo.autonomy, source: "config-file" },
      flight_powers: { value: repo.flightPowers ?? "standard", source: "config-file" },
    },
  };
}
