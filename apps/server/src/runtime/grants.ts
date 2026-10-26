import { MC_TOOL_NAMES, type McToolName } from "@mc/core";
import { type CcConfig, crewSeatDef, crewSeatGrants } from "../config.ts";
import type { RunIdentity } from "../mcp/tokens.ts";
import type { Store } from "../store.ts";

/**
 * The tools an authenticated run may use. `report_plan` is deliberately a property of a planless
 * build run, rather than a role grant: once the plan lands, the same token must lose it too.
 */
export function runSeatGrants(
  config: CcConfig,
  store: Pick<Store, "run" | "planLanded">,
  who: Pick<RunIdentity, "seatId" | "runId">,
): McToolName[] {
  const grants = crewSeatGrants(config, who.seatId);
  const run = store.run(who.runId);
  if (
    run?.agentId === who.seatId &&
    crewSeatDef(config, who.seatId).loop === "build" &&
    run.plan === undefined &&
    !store.planLanded(run)
  )
    return [...grants, MC_TOOL_NAMES.reportPlan];
  return grants;
}
