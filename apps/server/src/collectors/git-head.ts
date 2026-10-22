import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const REF = /^ref:\s*refs\/heads\/(\S.*?)\s*$/;
const GITDIR = /^gitdir:\s*(\S.*?)\s*$/;

/**
 * The branch checked out in `worktree`, read from its git HEAD with plain file reads (no git
 * process, nothing written). Handles a normal repo (`.git/HEAD`) and a linked worktree
 * (`.git` is a file `gitdir: <path>`, HEAD at `<path>/HEAD`). A detached HEAD, a missing or
 * malformed `.git`, or any read error yields null; never throws.
 */
export function currentBranch(worktree: string): string | null {
  try {
    const dotGit = join(worktree, ".git");
    let headPath = join(dotGit, "HEAD");
    let head: string;
    try {
      head = readFileSync(headPath, "utf8");
    } catch {
      const m = GITDIR.exec(readFileSync(dotGit, "utf8").split("\n")[0] ?? "");
      if (!m) return null;
      const gitdir = isAbsolute(m[1] as string)
        ? (m[1] as string)
        : resolve(dirname(dotGit), m[1] as string);
      headPath = join(gitdir, "HEAD");
      head = readFileSync(headPath, "utf8");
    }
    const ref = REF.exec(head.split("\n")[0] ?? "");
    return ref ? (ref[1] as string) : null;
  } catch {
    return null;
  }
}
