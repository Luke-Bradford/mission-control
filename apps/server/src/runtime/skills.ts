/**
 * The repo's skills (`.claude/skills/**`) as a seat sees them. `--restricted` loads no project
 * skills, so the hub reads them from the run's base commit through the same hash-verified reader as
 * CLAUDE.md, and hands them over as a plugin folder (Claude) or a skills folder in the seat's
 * CODEX_HOME (Codex). A skill is prompt text: one that holds anything but `SKILL.md` and plain text
 * files is left out whole. The folder has no hooks, bin or MCP config, so a repo cannot smuggle an
 * executable plugin part into a seat (docs/spikes/2026-10-29-seat-skills.md).
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SKILLS_DIR, skillFileProblem, skillPluginManifest } from "@mc/core";
import { type RepoDocs, readRepoDocs } from "./brief.ts";
import { readBaseEntry } from "./checkouts.ts";
import { crewGitBytes } from "./git.ts";

/** Limits on what one repo can put in a seat's plugin. */
const MAX_SKILLS = 50;
const MAX_FILES = 400;

export interface RepoSkill {
  name: string;
  /** Paths relative to the skill's folder, `SKILL.md` first. */
  files: { path: string; body: Buffer }[];
}

export interface RepoSkills {
  skills: RepoSkill[];
  /** One line per skill left out: `<skill>: <why>`. */
  refused: string[];
}

/** The skills in commit `baseSha` of the clone at `checkout`; the writable worktree is never read. */
export async function readRepoSkills(
  checkout: string,
  baseSha: string,
  maxFiles = MAX_FILES,
): Promise<RepoSkills> {
  const common = await realpath(join(checkout, ".git"));
  const tree = await crewGitBytes(
    checkout,
    ["ls-tree", "-r", "-z", "--full-tree", baseSha, "--", SKILLS_DIR],
    common,
    { gitDir: common },
  );
  const entries = tree
    .toString("utf8")
    .split("\0")
    .flatMap((e) => {
      const m = /^([0-7]+) (\w+) [0-9a-f]+\t([\s\S]+)$/.exec(e);
      return m === null ? [] : [{ mode: m[1] as string, path: m[3] as string }];
    });
  // a cut list could pass a skill whose refused file sits past the cut: no skill reaches the seat
  if (entries.length > maxFiles) {
    return { skills: [], refused: [`${SKILLS_DIR}: more than ${maxFiles} files`] };
  }
  const byName = new Map<string, { mode: string; path: string }[]>();
  const refused: string[] = [];
  for (const e of entries) {
    const name = e.path.slice(SKILLS_DIR.length + 1).split("/")[0] as string;
    byName.set(name, [...(byName.get(name) ?? []), e]);
  }
  const skills: RepoSkill[] = [];
  for (const [name, files] of byName) {
    const folder = `${SKILLS_DIR}/${name}/`;
    const read: RepoSkill["files"] = [];
    let problem: string | null = files.some((f) => !f.path.startsWith(folder))
      ? `${SKILLS_DIR}/${name} is not a skill folder`
      : null;
    for (const f of problem === null ? files : []) {
      const file = await readBaseEntry(checkout, baseSha, f.path);
      problem = skillFileProblem(f.path, f.mode, file?.body ?? Buffer.alloc(0));
      if (problem !== null) break;
      read.push({ path: f.path.slice(folder.length), body: file?.body as Buffer });
    }
    if (problem === null && !read.some((f) => f.path === "SKILL.md")) {
      problem = `${folder} has no SKILL.md`;
    }
    if (problem !== null) refused.push(`${name}: ${problem}`);
    else if (skills.length >= MAX_SKILLS) refused.push(`${name}: over ${MAX_SKILLS} skills`);
    else {
      read.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0));
      skills.push({ name, files: read });
    }
  }
  return { skills, refused };
}

function writeSkills(dir: string, skills: readonly RepoSkill[]): void {
  for (const s of skills) {
    for (const f of s.files) {
      const to = join(dir, s.name, f.path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, f.body, { mode: 0o444 });
      chmodSync(to, 0o444);
    }
  }
}

/** Rebuilds `dir` from nothing: the manifest and `skills/` only. */
export function writeSkillPlugin(
  dir: string,
  repoName: string,
  skills: readonly RepoSkill[],
): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), skillPluginManifest(repoName), {
    mode: 0o444,
  });
  writeSkills(join(dir, "skills"), skills);
}

/** Codex finds a user's skills in `$CODEX_HOME/skills`. */
export function copySkillsToCodexHome(home: string, skills: readonly RepoSkill[]): void {
  rmSync(join(home, "skills"), { recursive: true, force: true });
  writeSkills(join(home, "skills"), skills);
}

/**
 * The hub's shared skills: those in the hub's own checkout at its HEAD, for a seat on another repo
 * (`readRepoDocsAndSkills`). Unreadable: none, and the seat starts with its own repo's alone.
 */
export async function readHubSkills(hubRoot: string): Promise<RepoSkills> {
  try {
    const common = await realpath(join(hubRoot, ".git"));
    const head = (await crewGitBytes(hubRoot, ["rev-parse", "HEAD"], common, { gitDir: common }))
      .toString("utf8")
      .trim();
    return await readRepoSkills(hubRoot, head);
  } catch {
    return { skills: [], refused: [] };
  }
}

/**
 * The shared skills a start on `repoId` adds: the hub's, for a repo other than the one the hub's own
 * code lives in. None when the hub's repo is unknown, when it is `repoId` itself (it has them), or
 * when there is no hub checkout.
 */
export async function sharedSkillsFor(
  hubRepo: string | undefined,
  hubRoot: string,
  repoId: string,
): Promise<RepoSkills | undefined> {
  if (hubRepo === undefined || hubRepo === repoId || hubRoot === "") return undefined;
  return await readHubSkills(hubRoot);
}

/**
 * What a start reads from the base commit: CLAUDE.md, AGENTS.md and the skills. With `shared` (the
 * hub's skills, for a seat on another repo) the seat also gets each of those the repo has no skill of
 * the same name for: the repo's own always wins.
 */
export async function readRepoDocsAndSkills(
  checkout: string,
  baseSha: string,
  shared?: RepoSkills,
): Promise<RepoDocs> {
  const docs = await readRepoDocs(checkout, baseSha);
  // a repo whose skills cannot be read still starts its seat, without them
  const own = await readRepoSkills(checkout, baseSha).catch((e) => ({
    skills: [],
    refused: [`${SKILLS_DIR}: ${e instanceof Error ? e.message : String(e)}`],
  }));
  return { ...docs, skills: shared === undefined ? own : mergeSkills(own, shared) };
}

/** `own` plus the `shared` skills whose names `own` lacks. */
export function mergeSkills(own: RepoSkills, shared: RepoSkills): RepoSkills {
  const have = new Set(own.skills.map((s) => s.name));
  return {
    skills: [...own.skills, ...shared.skills.filter((s) => !have.has(s.name))],
    refused: own.refused,
  };
}
