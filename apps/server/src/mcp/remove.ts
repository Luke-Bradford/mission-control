/**
 * The commit tool's `remove`: a file in the worktree is looked at, and deleted, without following
 * a symlink above it. git is not used for the deletion: `git rm -f -- a/f.ts` with `a` a symlink to
 * an outside folder deletes the outside file (checked on git 2.54.0).
 */
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { GIT_TIMEOUT_MS } from "../files.ts";

const run = promisify(execFile);

/** A worktree path as seen without following a symlink above it. */
export type WorktreeEntry = "file" | "folder" | "missing" | "linked";

/**
 * $1 check|rm, $2 the parent folder's expected real path, $3 the file's name. The script goes to
 * the parent, checks it is where it should be, and unlinks relative to that cwd: a folder swapped
 * for a symlink afterwards cannot redirect it.
 */
export const REMOVE_SCRIPT = `cd -P -- "$2" 2>/dev/null || { echo missing; exit 0; }
[ "$(realpath .)" = "$2" ] || { echo linked; exit 0; }
if [ -d "$3" ] && [ ! -L "$3" ]; then echo folder; exit 0; fi
if [ ! -e "$3" ] && [ ! -L "$3" ]; then echo missing; exit 0; fi
ls -a | grep -Fqx -- "$3" || { echo linked; exit 0; }
if [ "$1" = rm ]; then rm -f -- "$3" || exit 1; fi
echo file`;

const ENTRIES: readonly string[] = ["file", "folder", "missing", "linked"];

/**
 * `path` (validated) in the worktree at real path `worktreeReal`; with `remove`, a `file` (not
 * a folder; a symlink itself, never its target) is deleted. Throws on failure or other output.
 */
export async function worktreeEntry(
  worktreeReal: string,
  path: string,
  remove: boolean,
): Promise<WorktreeEntry> {
  const parent = dirname(path);
  const dir = parent === "." ? worktreeReal : join(worktreeReal, parent);
  const { stdout } = await run(
    "/bin/sh",
    ["-c", REMOVE_SCRIPT, "mc-remove", remove ? "rm" : "check", dir, basename(path)],
    { env: { PATH: "/usr/bin:/bin" }, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
  );
  const out = stdout.trim();
  if (!ENTRIES.includes(out)) throw new Error("unexpected output from the remove script");
  return out as WorktreeEntry;
}

/** HEAD's entry for exactly `path` in `ls-tree -z` output. */
export function headEntryKind(lsTree: string, path: string): "file" | "folder" | "nested" | "none" {
  for (const entry of lsTree.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1 || entry.slice(tab + 1) !== path) continue;
    const mode = entry.slice(0, entry.indexOf(" "));
    if (mode === "100644" || mode === "100755" || mode === "120000") return "file";
    if (mode === "040000") return "folder";
    if (mode === "160000") return "nested";
  }
  return "none";
}
