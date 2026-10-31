import { accessSync, constants, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { SANDBOX_DENY_READ_HOME } from "@mc/core";
import { isInside } from "../config.ts";

/** The tools a seat runs its repo's checks with, besides the hub's own node. */
const PATH_TOOLS = ["node", "pnpm"] as const;

/** A tool's install folder: its `bin` folder's parent, or the folder it sits in. */
function installDir(binary: string): string {
  const dir = dirname(binary);
  return basename(dir) === "bin" ? dirname(dir) : dir;
}

function onPath(tool: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const file = join(dir, tool);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not in this folder
    }
  }
  return undefined;
}

/**
 * The folders a seat's sandbox re-allows for reads so its node and pnpm still run once the home
 * folder is denied: the install folder of the hub's own `execPath` and of `node` and `pnpm` found
 * on `path`, each both as found and with symlinks resolved. A folder that is or holds `home`, or
 * holds or lies inside a path in `denied` (the credential folders, the data dir, the rest of the
 * seat's read denies), would beat the deny: the binary's own folder is used instead, and none if that holds
 * one too.
 */
export function seatToolchainDirs(
  execPath: string,
  path: string,
  home: string,
  denied: string[],
): string[] {
  const found = [
    execPath,
    ...PATH_TOOLS.flatMap((t) => {
      const file = onPath(t, path);
      return file === undefined ? [] : [file];
    }),
  ];
  const bad = [...SANDBOX_DENY_READ_HOME.map((d) => join(home, d)), ...denied];
  const ok = (d: string) =>
    d !== "/" && !isInside(home, d) && !bad.some((x) => isInside(x, d) || isInside(d, x));
  const dirs = found.flatMap((f) => {
    const files = [f];
    try {
      files.push(realpathSync(f));
    } catch {
      // not resolvable: use it as found
    }
    return files.flatMap((x) => [installDir(x), dirname(x)].find(ok) ?? []);
  });
  return [...new Set(dirs)].sort();
}
