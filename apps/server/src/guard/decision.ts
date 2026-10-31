/** The guard reads repo powers and tool restrictions here, on every call. */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type CrewMode,
  type GuardEvent,
  type GuardVerdict,
  guardDecision,
  MC_SUPERUSER_TOOLS,
  type McToolName,
} from "@mc/core";
import { type CcConfig, flightPowersOf } from "../config.ts";
import { GIT_TIMEOUT_MS, gitEnv } from "../files.ts";
import { codexReadAllowed, realPathOrParent } from "../runtime/codex-floor.ts";

export function crewGuardDecision(
  config: CcConfig,
  repoId: string,
  mode: CrewMode,
  event: GuardEvent,
  superuserTools: readonly McToolName[] = MC_SUPERUSER_TOOLS,
  mcTools: readonly string[] = [],
  worktree?: string,
  commandCwd?: string,
  fullAccess = false,
): GuardVerdict {
  return guardDecision(
    event,
    {
      mode,
      fullAccess,
      gitDirectoryAllowed:
        worktree === undefined
          ? undefined
          : (directories) => {
              try {
                const identity = (cwd: string) =>
                  execFileSync("git", ["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
                    cwd,
                    encoding: "utf8",
                    timeout: GIT_TIMEOUT_MS,
                    env: {
                      ...gitEnv(process.env),
                      GIT_CONFIG_NOSYSTEM: "1",
                      GIT_CONFIG_GLOBAL: "/dev/null",
                    },
                  })
                    .trim()
                    .split("\n")
                    .map((path) => realpathSync(resolve(cwd, path)))
                    .join("\n");
                let cwd = commandCwd ?? worktree;
                if (!codexReadAllowed(cwd, worktree)) return false;
                cwd = realpathSync.native(cwd);
                for (const directory of directories) {
                  cwd = realpathSync.native(
                    isAbsolute(directory) ? directory : `${cwd}/${directory}`,
                  );
                }
                return identity(cwd) === identity(worktree);
              } catch {
                return false;
              }
            },
      gitPathAllowed:
        worktree === undefined
          ? undefined
          : (path, directories) => {
              let cwd = commandCwd ?? worktree;
              for (const directory of directories) {
                const real = realPathOrParent(
                  isAbsolute(directory) ? directory : `${cwd}/${directory}`,
                );
                if (real === null || !codexReadAllowed(real, worktree)) return false;
                cwd = real;
              }
              return codexReadAllowed(isAbsolute(path) ? path : `${cwd}/${path}`, worktree);
            },
      mcTools,
      repo: "dev",
      flightPowers: flightPowersOf(config, repoId),
      fullSuite: config.repos.find((r) => r.id === repoId)?.fullSuite ?? [],
    },
    superuserTools,
  );
}
