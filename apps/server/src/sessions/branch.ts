import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Read a checkout's branch and GitHub origin without running git. */
export async function gitPlace(
  folder: string,
): Promise<{ branch: string | null; github: string | null } | null> {
  let dir = resolve(folder);
  for (let depth = 0; depth < 64; depth++) {
    const dot = join(dir, ".git");
    const stat = await lstat(dot).catch(() => null);
    if (stat?.isDirectory() || stat?.isFile()) {
      let gitdir = dot;
      if (stat.isFile()) {
        const line = await readFile(dot, "utf8").catch(() => "");
        const named = /^gitdir:\s*(.+?)\s*$/m.exec(line)?.[1];
        if (named === undefined) return null;
        gitdir = isAbsolute(named) ? named : resolve(dir, named);
      }
      const head = await readFile(join(gitdir, "HEAD"), "utf8").catch(() => "");
      const branch = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)?.[1] ?? null;
      const common = await readFile(join(gitdir, "commondir"), "utf8")
        .then((v) => resolve(gitdir, v.trim()))
        .catch(() => gitdir);
      const config = await readFile(join(common, "config"), "utf8").catch(() => "");
      const origin = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(\S+)/.exec(config)?.[1] ?? "";
      const github =
        /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1]?.toLowerCase() ??
        null;
      return { branch, github };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
