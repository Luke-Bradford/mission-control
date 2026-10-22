/**
 * A repo's board rules: the `mc:` block in the yaml fence under the `## Mission Control` heading of
 * its `CLAUDE.md`, read at `origin/HEAD`. A bad block is refused with the key it names; the engine
 * stops refills for that repo until it is fixed.
 *
 * Only a repo with no such heading gets the defaults. A heading whose block is missing, unclosed,
 * empty or not a mapping is refused: the repo meant to set rules, and defaults would silently
 * widen what seats may pick.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_HARD_RULES,
  DEFAULT_REPO_RULES,
  freezeRules,
  REPO_NEEDS,
  type RepoRules,
} from "@mc/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readRepoClaudeMd } from "../runtime/brief.ts";
import { crewGit } from "../runtime/git.ts";

export class RepoRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRulesError";
  }
}

const HEADING = /^ {0,3}##[ \t]+mission control(?:[ \t]+#+)?[ \t]*$/i;
const OTHER_HEADING = /^ {0,3}##(?:[ \t]|$)/;
/** A fence line: up to three spaces, then three or more backticks or tildes, then the info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const YAML_INFO = /^[ \t]*ya?ml(?:[ \t]|$)/i;
const NO_BLOCK = "the Mission Control section has no yaml block";

/** Keys accepted but not used here (other parts of the board automation own them). */
const IGNORED_KEYS = ["templates", "ci"];

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
// `pick_from: []` is refused on purpose: pausing a repo is not this key's job. Status names are
// not checked against the board here; the engine reports a status it cannot find.
const schema = z.strictObject({
  pick_from: z.array(nonEmpty).min(1).optional(),
  promote_backlog: z.boolean().optional(),
  needs: z.array(z.enum(REPO_NEEDS)).optional(),
  areas: z.record(nonEmpty, z.array(labelGlob).min(1)).optional(),
  // `null` means the default only here (the example block writes `hard_rules: null`); `[]` is none.
  hard_rules: z.array(nonEmpty).nullable().optional(),
  always_ask: z.array(nonEmpty).optional(),
});

/**
 * The text of the first yaml fence between the `## Mission Control` heading and the next `## `
 * heading, or null when there is no such heading. Headings count only outside code fences.
 *
 * Not handled: an HTML comment does not hide a heading or a fence; a `# ` H1 does not end the
 * section (only a `## ` heading does); a setext heading (text over `---`) is not a heading.
 */
function mcBlock(markdown: string): string | null {
  const lines = markdown.replace(/^﻿/, "").split(/\r?\n/);
  let fence: { mark: string; yaml: boolean } | null = null;
  let seen = false;
  let body: string[] = [];
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      const closes =
        f !== null &&
        f[2]?.trim() === "" &&
        f[1]?.[0] === fence.mark[0] &&
        (f[1]?.length ?? 0) >= fence.mark.length;
      if (!closes) {
        body.push(line);
        continue;
      }
      if (seen && fence.yaml) return body.join("\n");
      fence = null;
      body = [];
      continue;
    }
    if (f !== null) {
      fence = { mark: f[1] ?? "", yaml: seen && YAML_INFO.test(f[2] ?? "") };
      continue;
    }
    if (!seen) {
      seen = HEADING.test(line);
    } else if (OTHER_HEADING.test(line)) {
      throw new RepoRulesError(NO_BLOCK);
    }
  }
  if (!seen) return null;
  throw new RepoRulesError(NO_BLOCK);
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The rules in a `CLAUDE.md`'s text; the defaults when it has no `## Mission Control` heading. */
export function parseRepoRules(markdown: string | null): RepoRules {
  const block = markdown === null ? null : mcBlock(markdown);
  if (block === null) return DEFAULT_REPO_RULES;
  let doc: unknown;
  try {
    doc = parseYaml(block);
  } catch (e) {
    throw new RepoRulesError(
      `the Mission Control block is not valid YAML: ${(e as Error).message}`,
    );
  }
  if (!isMapping(doc)) {
    throw new RepoRulesError("the Mission Control block must be a mapping with an `mc` key");
  }
  const mc = doc.mc;
  if (!isMapping(mc)) throw new RepoRulesError("mc: must be a mapping");
  const known = Object.fromEntries(Object.entries(mc).filter(([k]) => !IGNORED_KEYS.includes(k)));
  if (isMapping(known.areas) && Object.keys(known.areas).includes("__proto__")) {
    throw new RepoRulesError('mc.areas: the label "__proto__" is not allowed');
  }
  const parsed = schema.safeParse(known);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) throw new RepoRulesError("invalid Mission Control block");
    if (issue.code === "unrecognized_keys") {
      throw new RepoRulesError(`unknown key ${issue.keys.map((k) => `"${k}"`).join(", ")} in mc:`);
    }
    throw new RepoRulesError(`mc.${issue.path.map(String).join(".")}: ${issue.message}`);
  }
  const r = parsed.data;
  return freezeRules({
    pickFrom: r.pick_from ?? DEFAULT_REPO_RULES.pickFrom,
    promoteBacklog: r.promote_backlog ?? DEFAULT_REPO_RULES.promoteBacklog,
    needs: r.needs ?? DEFAULT_REPO_RULES.needs,
    areas:
      r.areas === undefined
        ? DEFAULT_REPO_RULES.areas
        : Object.fromEntries(Object.entries(r.areas)),
    hardRules: r.hard_rules ?? DEFAULT_HARD_RULES,
    alwaysAsk: r.always_ask ?? DEFAULT_REPO_RULES.alwaysAsk,
  });
}

/** The latest `origin/HEAD` sha read per checkout, and what it came to. */
const cache = new Map<string, { sha: string; outcome: RepoRules | RepoRulesError }>();

/**
 * The repo's rules at `origin/HEAD` of the crew clone at `checkout`. Returns the error rather than
 * throwing (a block that does not parse, or a clone that cannot be read); a parse outcome is cached
 * by sha (the latest per checkout), a failed read is not.
 */
export async function readRepoRules(
  repo: string,
  checkout: string,
): Promise<RepoRules | RepoRulesError> {
  try {
    const common = await realpath(join(checkout, ".git"));
    // The full ref name: a local branch called `origin/HEAD` would shadow the short one.
    const sha = (
      await crewGit(
        checkout,
        ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"],
        common,
        { gitDir: common },
      )
    ).trim();
    const known = cache.get(checkout);
    if (known !== undefined && known.sha === sha) return known.outcome;
    const markdown = await readRepoClaudeMd(checkout, sha);
    let outcome: RepoRules | RepoRulesError;
    try {
      outcome = parseRepoRules(markdown);
    } catch (e) {
      if (!(e instanceof RepoRulesError)) throw e;
      outcome = new RepoRulesError(`${repo}: ${e.message}`);
    }
    cache.set(checkout, { sha, outcome });
    return outcome;
  } catch (e) {
    return new RepoRulesError(
      `${repo}: cannot read CLAUDE.md at origin/HEAD: ${(e as Error).message}`,
    );
  }
}
