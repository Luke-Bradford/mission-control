/**
 * A seat's `node` and `pnpm` must be the hub's Node (`engines` in package.json): another node
 * found first (Homebrew's) runs the checks on a version where tests that pass on the hub fail.
 */
import { delimiter, dirname } from "node:path";

/** The folder under the crew worktrees root that holds the seat zsh's startup files. */
export const ZSH_NODE_FIRST_DIR = ".mc-zsh";

/** `path` with the folder of `execPath` first (moved, not repeated). */
export function nodeFirstPath(execPath: string, path: string): string {
  const dir = dirname(execPath);
  return [dir, ...path.split(delimiter).filter((p) => p !== "" && p !== dir)].join(delimiter);
}

/**
 * The seat zsh's `.zprofile`. A login shell runs /etc/zprofile (path_helper) before it, and may
 * add Homebrew's folders, so the environment's PATH alone does not hold.
 */
export function zprofileNodeFirst(execPath: string): string {
  const dir = `'${dirname(execPath).replaceAll("'", `'\\''`)}'`;
  return `path=(${dir} \${path:#${dir}})\nexport PATH\n`;
}
