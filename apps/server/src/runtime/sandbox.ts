import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realish } from "../config.ts";
import { crewGit } from "./git.ts";

/** Global config and include targets, resolved before constructing the sandbox's read grants. */
export async function crewGitConfigPaths(
  cwd: string,
  commonDir: string,
): Promise<{ allowRead: string[]; denyRead: string[] }> {
  const home = homedir();
  const configDir = realish(join(home, ".config/git"));
  const allowRead = [realish(join(home, ".gitconfig")), configDir];
  for (const [option, key] of [
    ["--get-all", "include.path"],
    ["--get-regexp", "^includeif\\..*\\.path$"],
  ] as const) {
    let out: string;
    try {
      out = await crewGit(
        cwd,
        ["config", "--global", "--includes", "--null", "--show-origin", "--path", option, key],
        commonDir,
      );
    } catch (e) {
      // git config exits 1 when there are no matching keys. Other errors must not hide config.
      if ((e as { code?: unknown }).code === 1) continue;
      throw e;
    }
    const fields = out.split("\0");
    for (let n = 0; n + 1 < fields.length; n += 2) {
      const origin = fields[n];
      const entry = fields[n + 1];
      if (!origin?.startsWith("file:") || entry === undefined) continue;
      const value = option === "--get-regexp" ? entry.slice(entry.indexOf("\n") + 1) : entry;
      if (value === "") continue;
      const source = origin.slice(5);
      allowRead.push(realish(resolve(dirname(resolve(cwd, source)), value)));
    }
  }
  return {
    allowRead: [...new Set(allowRead)],
    denyRead: [join(configDir, "credentials")],
  };
}
