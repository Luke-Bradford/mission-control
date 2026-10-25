/** The guard reads repo powers and tool restrictions here, on every call. */

import { isAbsolute } from "node:path";
import {
  type CrewMode,
  type GuardEvent,
  type GuardVerdict,
  guardDecision,
  MC_SUPERUSER_TOOLS,
  type McToolName,
} from "@mc/core";
import { type CcConfig, flightPowersOf } from "../config.ts";
import { codexReadAllowed, realPathOrParent } from "../runtime/codex-floor.ts";

export function crewGuardDecision(
  config: CcConfig,
  repoId: string,
  mode: CrewMode,
  event: GuardEvent,
  superuserTools: readonly McToolName[] = MC_SUPERUSER_TOOLS,
  mcTools: readonly string[] = [],
  worktree?: string,
): GuardVerdict {
  return guardDecision(
    event,
    {
      mode,
      gitPathAllowed:
        worktree === undefined
          ? undefined
          : (path, directories) => {
              let cwd = worktree;
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
