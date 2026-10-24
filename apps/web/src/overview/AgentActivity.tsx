// biome-ignore-all lint/a11y/useSemanticElements: ARIA table roles preserve the responsive CSS grid layout.
import type { CrewRow } from "@mc/core";
import { cost, kTokens } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Sparkline } from "../hud/Sparkline.tsx";
import { ACTIVITY_MINUTES, activityLive, activityValues } from "./agentActivity.ts";

export function AgentActivity({ row, now, max }: { row: CrewRow; now: number; max: number }) {
  const values = activityValues(row.digest, now);
  const rate = kTokens(values.reduce((a, b) => a + b, 0) / ACTIVITY_MINUTES);
  const tokens = row.run?.tokens;
  return (
    <div role="cell" className="agent-activity tok">
      <Sparkline values={values} color={agentColor(row.index)} max={max} />
      {activityLive(row.digest, now) && (
        <i
          className="activity-live"
          role="img"
          aria-label="Live token activity"
          title="Active in the last minute"
        />
      )}
      <span
        className="ellip xs muted num"
        title={`${rate}/min · Average input + output tokens per minute over the last 30 minutes${tokens ? ` · Input ${kTokens(tokens.input)} · Output ${kTokens(tokens.output)} · Cache read ${kTokens(tokens.cacheRead)} · Cache write ${kTokens(tokens.cacheCreate)}` : ""}`}
      >
        {rate}/min
      </span>
    </div>
  );
}

export function AgentCost({ row }: { row: CrewRow | null }) {
  const runCost =
    row?.run?.status === "running"
      ? (row.run.costEstimateUsd ?? row.run.costUsd)
      : row?.run?.costUsd;
  return (
    <span role="cell" className="xs muted num" title="Estimated run cost">
      {cost(runCost ?? null)}
    </span>
  );
}
