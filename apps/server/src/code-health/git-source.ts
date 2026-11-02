import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type GitExec, readOnlyObjectBase, realGitExec } from "../files.ts";
import { RISK_MEMBERSHIP_MAX, RISK_PR_MAX, riskPath } from "./risk.ts";

export const GIT_FILE_SOURCE_VERSION = 1;
const SHA = /^[a-f0-9]{40,64}$/;
const MARKER = "MC_CODE_HEALTH_COMMIT";
export interface GitFileChange {
  path: string;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
}
export interface GitFileCommit {
  sha: string;
  committedAt: number;
  parents: string[];
  rawPaths: string[];
  excludedPaths: string[];
  changes: GitFileChange[];
}

/** Parse git's NUL-delimited rename form, never its human-readable brace/arrow notation. */
export function parseGitFileLog(output: string): GitFileCommit[] {
  if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw Error("Git file evidence output limit");
  const parts = output.split("\0"),
    commits: GitFileCommit[] = [];
  const seen = new Set<string>();
  let current: GitFileCommit | undefined,
    memberships = 0,
    rawMemberships = 0;
  const count = (value: string) => {
    if (value === "-") return null;
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
      throw Error("Invalid git numstat count");
    return number;
  };
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].startsWith("\n") ? parts[i].slice(1) : parts[i];
    if (token === "") continue;
    if (token === MARKER) {
      const sha = parts[++i],
        seconds = parts[++i],
        parents = parts[++i]?.split(" ").filter(Boolean) ?? [];
      if (
        !SHA.test(sha ?? "") ||
        parents.length > 100 ||
        !parents.every((parent) => SHA.test(parent)) ||
        !/^\d+$/.test(seconds ?? "") ||
        !Number.isSafeInteger(Number(seconds) * 1000)
      )
        throw Error("Invalid git file commit");
      if (seen.has(sha)) throw Error("Duplicate git file commit");
      seen.add(sha);
      current = {
        sha,
        committedAt: Number(seconds) * 1000,
        parents,
        changes: [],
        rawPaths: [],
        excludedPaths: [],
      };
      commits.push(current);
      if (commits.length > RISK_PR_MAX) throw Error("Git file commit limit");
      continue;
    }
    const raw = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]{40,64} [a-f0-9]{40,64} ([A-Z])\d*$/.exec(token);
    if (raw) {
      if (!current) throw Error("Git raw path before commit");
      const paths = raw[3] === "R" || raw[3] === "C" ? [parts[++i], parts[++i]] : [parts[++i]];
      if (!paths.every(riskPath)) throw Error("Unsupported raw git path");
      current.rawPaths.push(...paths);
      rawMemberships += paths.length;
      if (rawMemberships > RISK_MEMBERSHIP_MAX) throw Error("Git raw membership limit");
      if (raw[1] === "160000" || raw[2] === "160000") current.excludedPaths.push(...paths);
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!current || !match) throw Error("Invalid git numstat record");
    let path = match[3],
      previousPath: string | null = null;
    if (path === "") {
      previousPath = parts[++i];
      path = parts[++i];
    }
    if (!riskPath(path) || (previousPath !== null && !riskPath(previousPath)))
      throw Error("Unsupported git evidence path");
    if (++memberships > RISK_MEMBERSHIP_MAX) throw Error("Git file membership limit");
    const additions = count(match[1]),
      deletions = count(match[2]);
    if ((additions === null) !== (deletions === null)) throw Error("Invalid binary numstat");
    current.changes.push({ path, previousPath, additions, deletions });
  }
  for (const commit of commits) {
    commit.rawPaths = [...new Set(commit.rawPaths)];
    commit.excludedPaths = [...new Set(commit.excludedPaths)];
    const raw = new Set(commit.rawPaths);
    const covered = new Set(
      commit.changes.flatMap((change) =>
        change.previousPath ? [change.path, change.previousPath] : [change.path],
      ),
    );
    const excluded = new Set(commit.excludedPaths);
    if (commit.rawPaths.some((path) => !excluded.has(path) && !covered.has(path)))
      throw Error("Raw paths lack numstat coverage");
    if (
      commit.changes.some(
        (change) =>
          !raw.has(change.path) || (change.previousPath !== null && !raw.has(change.previousPath)),
      )
    )
      throw Error("Numstats lack raw path provenance");
  }
  return commits;
}

/** Local info rules override tree attributes. Reject them rather than cache machine-dependent counts. */
async function noLocalOverrides(checkout: string, base: string[], exec: GitExec) {
  try {
    const overrides = await exec([...base, "config", "--get-regexp", "^diff\\..*\\.binary$"]);
    if (overrides.trim()) throw Error("Named diff binary overrides prevent immutable evidence");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 1) throw error;
  }
  for (const name of ["info/attributes", "info/grafts"]) {
    const path = (await exec([...base, "rev-parse", "--git-path", name])).trim();
    if (!path) throw Error("Cannot resolve local attribute scope");
    const file = await open(
      isAbsolute(path) ? path : join(checkout, path),
      constants.O_RDONLY | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) continue;
    try {
      if (!(await file.stat()).isFile()) throw Error("Unsupported local attribute source");
      const buffer = Buffer.alloc(65537),
        { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (
        bytesRead > 65536 ||
        buffer
          .subarray(0, bytesRead)
          .toString("utf8")
          .split(/\r?\n/)
          .some((line) => line.trim() && !line.trim().startsWith("#"))
      )
        throw Error(
          name === "info/attributes"
            ? "Local attribute rules prevent immutable git evidence"
            : "Local graft rules prevent immutable git evidence",
        );
    } finally {
      await file.close();
    }
  }
}

/** Committed objects only. The caller persists the result under repo, checkout and immutable SHA. */
export async function gitFileHead(checkout: string, exec: GitExec = realGitExec) {
  const base = await readOnlyObjectBase(checkout, exec);
  const sha = (await exec([...base, "rev-parse", "--verify", "origin/HEAD^{commit}"])).trim();
  if (!SHA.test(sha)) throw Error("Invalid git evidence head");
  await noLocalOverrides(checkout, base, exec);
  return sha;
}
export async function collectGitFileSource(
  checkout: string,
  exec: GitExec = realGitExec,
  from = Math.floor(Date.now() / 86400000) * 86400000 - 91 * 86400000,
  immutableSha?: string,
) {
  const started = performance.now(),
    base = await readOnlyObjectBase(checkout, exec);
  const sha = immutableSha ?? (await gitFileHead(checkout, exec));
  if (!SHA.test(sha) || !Number.isSafeInteger(from) || from < 0)
    throw Error("Invalid git evidence scope");
  await noLocalOverrides(checkout, base, exec);
  const output = await exec([
    ...base,
    `--attr-source=${sha}`,
    "-c",
    "diff.renameLimit=2000",
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-show-signature",
    "--no-decorate",
    "--no-notes",
    "--numstat",
    "--raw",
    "--no-abbrev",
    "-z",
    "-M",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--ignore-submodules=dirty",
    "--submodule=short",
    `--since=${new Date(from).toISOString()}`,
    `--format=%x00${MARKER}%x00%H%x00%ct%x00%P%x00`,
    `--max-count=${RISK_PR_MAX + 1}`,
    sha,
    "--",
  ]);
  await noLocalOverrides(checkout, base, exec);
  const commits = parseGitFileLog(output);
  if (!commits.length || commits[0].sha !== sha) throw Error("Git evidence head mismatch");
  return {
    version: GIT_FILE_SOURCE_VERSION,
    from,
    analysedSha: sha,
    commits,
    elapsedMs: performance.now() - started,
  };
}
