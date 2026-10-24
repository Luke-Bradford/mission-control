/** The guard reads repo powers and tool restrictions here, on every call. */
import {
  type CrewMode,
  type GuardEvent,
  type GuardVerdict,
  guardDecision,
  MC_SUPERUSER_TOOLS,
  type McToolName,
} from "@mc/core";
import { type CcConfig, flightPowersOf } from "../config.ts";

export function crewGuardDecision(
  config: CcConfig,
  repoId: string,
  mode: CrewMode,
  event: GuardEvent,
  superuserTools: readonly McToolName[] = MC_SUPERUSER_TOOLS,
): GuardVerdict {
  return guardDecision(
    event,
    {
      mode,
      repo: "dev",
      flightPowers: flightPowersOf(config, repoId),
      fullSuite: config.repos.find((r) => r.id === repoId)?.fullSuite ?? [],
    },
    superuserTools,
  );
}
