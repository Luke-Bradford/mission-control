import { type GitExec, readOnlyBase, realGitExec } from "../repo/files.ts";

/** Where a fix's changed lines came from. */
export interface FixTrace {
  /** The commit that wrote most of the lines the fix changed. */
  commit: string;
  /** The PR that commit came in on, when its message or its merge commit names one. */
  prNumber: number | null;
  /** The merge (or squash) commit that brought it onto the line the fix is on. */
  mergeSha: string;
  /** When `mergeSha` was committed, in ms. */
  mergedAt: number;
  /** Files the fix changed that existed before it. */
  fixedFiles: string[];
  /** Files the introducing PR changed. */
  introFiles: string[];
}

/** Bounds on one trace, so a huge fix costs a bounded number of git calls. */
export const TRACE_MAX_FILES = 20;
export const TRACE_MAX_LINES = 400;

const FULL_SHA = /^[a-f0-9]{40,64}$/;
const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/;
const MERGE_SUBJECT = /^Merge pull request #(\d+)\b/;

interface Range {
  path: string;
  start: number;
  end: number;
}

/**
 * The old-side line ranges a diff changed. A pure insertion has no old lines, so it takes the
 * line before it. New files (no old side) and quoted paths are left out.
 */
export function oldRanges(diff: string): Range[] {
  const out: Range[] = [];
  let path: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      path = p.startsWith("a/") && !p.startsWith('"') ? p.slice(2) : null;
    } else if (line.startsWith("@@ ") && path !== null) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      if (m === null) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) out.push({ path, start, end: start + count - 1 });
      else if (start > 0) out.push({ path, start, end: start });
    }
  }
  return out;
}

/** The commit owning the most lines in one `git blame --porcelain` output. */
function blameCounts(porcelain: string, into: Map<string, number>): void {
  for (const line of porcelain.split("\n")) {
    const m = /^([a-f0-9]{40,64}) \d+ \d+/.exec(line);
    if (m !== null) into.set(m[1], (into.get(m[1]) ?? 0) + 1);
  }
}

/**
 * Traces a merged fix to the commit that introduced the bug: blames the fix's parent over the
 * lines the fix changed and takes the commit owning most of them. Local git only, read-only; null
 * when the fix is not a full commit id, has no parent or old lines, or git cannot answer.
 */
export async function traceFix(
  checkout: string,
  fixSha: string,
  exec: GitExec = realGitExec,
): Promise<FixTrace | null> {
  if (!FULL_SHA.test(fixSha)) return null;
  try {
    const base = await readOnlyBase(checkout, exec);
    const parent = (
      await exec([...base, "rev-parse", "--verify", "--end-of-options", `${fixSha}^1`])
    ).trim();
    if (!FULL_SHA.test(parent)) return null;
    const diff = await exec([
      ...base,
      "diff",
      "-U0",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--no-renames",
      parent,
      fixSha,
      "--",
    ]);
    const ranges = oldRanges(diff);
    const files = [...new Set(ranges.map((r) => r.path))].slice(0, TRACE_MAX_FILES);
    const counts = new Map<string, number>();
    let budget = TRACE_MAX_LINES;
    for (const r of ranges) {
      if (budget <= 0 || !files.includes(r.path)) continue;
      const end = Math.min(r.end, r.start + budget - 1);
      budget -= end - r.start + 1;
      try {
        blameCounts(
          await exec([
            ...base,
            "blame",
            "--porcelain",
            "-L",
            `${r.start},${end}`,
            parent,
            "--",
            r.path,
          ]),
          counts,
        );
      } catch {
        // a range past the file's end, or a path git cannot blame: leave it out
      }
    }
    if (counts.size === 0) return null;
    const commit = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0][0];
    const pr = await introducingPr(base, exec, commit, parent);
    const introFiles = (
      await exec([
        ...base,
        "diff-tree",
        "--diff-merges=first-parent",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--no-renames",
        pr.mergeSha,
        "--",
      ])
    )
      .split("\n")
      .filter((f) => f !== "");
    return {
      commit,
      prNumber: pr.prNumber,
      mergeSha: pr.mergeSha,
      mergedAt: pr.at,
      fixedFiles: files,
      introFiles,
    };
  } catch {
    return null;
  }
}

/** The PR a commit came in on: a number in its subject, else the oldest "Merge pull request" above it. */
async function introducingPr(
  base: string[],
  exec: GitExec,
  commit: string,
  tip: string,
): Promise<{ prNumber: number | null; mergeSha: string; at: number }> {
  const row = (out: string) => {
    const [sha, ct, ...subject] = out.split("\0");
    return { sha, at: Number(ct) * 1000, subject: subject.join("\0").trim() };
  };
  const own = row(
    await exec([...base, "log", "-1", "--format=%H%x00%ct%x00%s", "--end-of-options", commit]),
  );
  const named = SQUASH_SUBJECT.exec(own.subject) ?? MERGE_SUBJECT.exec(own.subject);
  if (named !== null) return { prNumber: Number(named[1]), mergeSha: own.sha, at: own.at };
  const merges = (
    await exec([
      ...base,
      "log",
      "--merges",
      "--ancestry-path",
      "--reverse",
      "--format=%H%x00%ct%x00%s",
      `${commit}..${tip}`,
    ])
  )
    .split("\n")
    .filter((l) => l !== "")
    .map(row);
  for (const m of merges) {
    const n = MERGE_SUBJECT.exec(m.subject);
    if (n !== null) return { prNumber: Number(n[1]), mergeSha: m.sha, at: m.at };
  }
  return { prNumber: null, mergeSha: own.sha, at: own.at };
}
