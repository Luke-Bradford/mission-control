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
 * holds a credential folder in it, is left out: re-allowing it would beat the deny.
 */
export function seatToolchainDirs(execPath: string, path: string, home: string): string[] {
  const found = [
    execPath,
    ...PATH_TOOLS.flatMap((t) => {
      const file = onPath(t, path);
      return file === undefined ? [] : [file];
    }),
  ];
  const dirs = found.flatMap((f) => {
    try {
      return [installDir(f), installDir(realpathSync(f))];
    } catch {
      return [installDir(f)];
    }
  });
  const credentials = SANDBOX_DENY_READ_HOME.map((d) => join(home, d));
  return [...new Set(dirs)]
    .filter((d) => d !== "/" && !isInside(home, d) && !credentials.some((c) => isInside(c, d)))
    .sort();
}
