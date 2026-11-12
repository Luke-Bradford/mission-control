// biome-ignore-all lint/a11y/useSemanticElements: ARIA table roles preserve the responsive CSS grid layout.
import type { CrewRow } from "@mc/core";
import { cost } from "../fmt.ts";

export function AgentCost({ row }: { row: CrewRow | null }) {
  const runCost =
    row?.run?.status === "running"
      ? (row.run.costEstimateUsd ?? row.run.costUsd)
      : row?.run?.costUsd;
  return (
    <span role="cell" className="xs muted num crew-wide" title="Estimated run cost">
      {cost(runCost ?? null)}
    </span>
  );
}
