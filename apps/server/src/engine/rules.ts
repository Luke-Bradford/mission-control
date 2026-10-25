/**
 * User-config rules with an optional `mc:` block under `## Mission Control` in the repo's
 * `CLAUDE.md`, read at `origin/HEAD`. A bad block is refused with the key it names; the engine
 * stops refills for that repo until it is fixed.
 *
 * Only a repo with no such heading inherits all user-config rules. A heading whose block is missing,
 * unclosed, empty or not a mapping is refused: the repo meant to set rules, and defaults would silently
 * widen what seats may pick.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_REPO_RULES, type RepoRules } from "@mc/core";
import { parse as parseYaml } from "yaml";
import { readRepoClaudeMd } from "../runtime/brief.ts";
import { crewGit } from "../runtime/git.ts";
import { overlayRepoBlock, repoRulesSchema } from "./rule-config.ts";

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

/** The whole Mission Control section, including its heading and prose. */
export function mcSection(markdown: string): string | null {
  const lines = markdown.replace(/^﻿/, "").split(/\r?\n/);
  let fence: string | null = null;
  let start = -1;
  for (const [i, line] of lines.entries()) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[2]?.trim() === "" && f[1]?.[0] === fence[0] && (f[1]?.length ?? 0) >= fence.length)
        fence = null;
    } else if (f) {
      fence = f[1] ?? null;
    } else if (start < 0) {
      if (HEADING.test(line)) start = i;
    } else if (/^ {0,3}#{1,2}(?:[ \t]|$)/.test(line)) {
      return `${lines.slice(start, i).join("\n")}\n`;
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n");
}

/** Keys accepted but not used here (other parts of the board automation own them). */
const IGNORED_KEYS = ["ci"];

/**
 * The text of the first yaml fence between the `## Mission Control` heading and the next `## `
 * heading, or null when there is no such heading. Headings count only outside code fences.
 *
 * Not handled: an HTML comment does not hide a heading or a fence; a `# ` H1 does not end the
 * section (only a `## ` heading does); a setext heading (text over `---`) is not a heading.
 */
export function mcBlock(markdown: string): string | null {
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

/** The optional repo block tightens user-config rules and fills omitted keys; notes go to the caller. */
export function parseRepoRules(
  markdown: string | null,
  base: RepoRules = DEFAULT_REPO_RULES,
  notes: string[] = [],
): RepoRules {
  const block = markdown === null ? null : mcBlock(markdown);
  if (block === null) return base;
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
  if (
    Object.hasOwn(known, "templates") &&
    !repoRulesSchema.shape.templates.safeParse(known.templates).success
  ) {
    notes.push(
      "mc.templates: invalid legacy value ignored; inheriting user templates when present",
    );
    if (base.templates === undefined) known.templates = {};
    else delete known.templates;
  }
  const parsed = repoRulesSchema.safeParse(known);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) throw new RepoRulesError("invalid Mission Control block");
    if (issue.code === "unrecognized_keys") {
      throw new RepoRulesError(`unknown key ${issue.keys.map((k) => `"${k}"`).join(", ")} in mc:`);
    }
    throw new RepoRulesError(`mc.${issue.path.map(String).join(".")}: ${issue.message}`);
  }
  return overlayRepoBlock(base, parsed.data);
}

/** The latest `origin/HEAD` sha read per checkout, and what it came to. */
const cache = new Map<
  string,
  { sha: string; base: RepoRules; outcome: RepoRules | RepoRulesError }
>();

/**
 * The repo's rules at `origin/HEAD` of the crew clone at `checkout`. Returns the error rather than
 * throwing (a block that does not parse, or a clone that cannot be read); a parse outcome is cached
 * by sha and user-config rules (the latest per checkout), a failed read is not.
 * A merge gate supplies its fetched main sha so a moving origin/HEAD cannot change the rules.
 * Nonfatal parse notes are appended for the caller to log, only on a fresh parse.
 */
export async function readRepoRules(
  repo: string,
  checkout: string,
  base: RepoRules = DEFAULT_REPO_RULES,
  notes: string[] = [],
  mainSha?: string,
): Promise<RepoRules | RepoRulesError> {
  try {
    const common = await realpath(join(checkout, ".git"));
    // The full ref name: a local branch called `origin/HEAD` would shadow the short one.
    const sha =
      mainSha ??
      (
        await crewGit(
          checkout,
          ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"],
          common,
          { gitDir: common },
        )
      ).trim();
    const known = cache.get(checkout);
    if (known !== undefined && known.sha === sha && known.base === base) return known.outcome;
    const markdown = await readRepoClaudeMd(checkout, sha);
    let outcome: RepoRules | RepoRulesError;
    try {
      const parseNotes: string[] = [];
      outcome = parseRepoRules(markdown, base, parseNotes);
      notes.push(...parseNotes.map((note) => `${repo}: ${note}`));
    } catch (e) {
      if (!(e instanceof RepoRulesError)) throw e;
      outcome = new RepoRulesError(`${repo}: ${e.message}`);
    }
    cache.set(checkout, { sha, base, outcome });
    return outcome;
  } catch (e) {
    return new RepoRulesError(
      `${repo}: cannot read CLAUDE.md at origin/HEAD: ${(e as Error).message}`,
    );
  }
}

/** Elevation is user config only; a repo cannot appoint FLIGHT itself. */
export function hardRulesBy(
  rules: RepoRules,
  powers: "standard" | "superuser",
): RepoRules["hardRulesBy"] {
  return powers === "superuser" ? "flight" : rules.hardRulesBy;
}
