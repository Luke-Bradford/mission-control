import type { CrewRow, Telemetry } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { kTokens } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { VBars } from "../hud/charts/VBars.tsx";

const TURN_KINDS = [
  { key: "input", label: "input" },
  { key: "output", label: "output" },
  { key: "cacheRead", label: "cache read" },
] as const;

/**
 * Tokens per turn for this seat's latest run, finished or not. One run of one seat belongs on the
 * seat's page, not on the crew's Telemetry. Reads the telemetry route scoped to the seat; its
 * `turnUsage` does not depend on the range, so the shortest one is asked for.
 */
export function TokensPerTurn({ row }: { row: CrewRow }) {
  const res = useResource<Telemetry>(RESOURCES.telemetry("1h", row.id));
  if (!res.data)
    return res.error ? (
      <p className="crit-t">Could not load the turns: {res.error.message}</p>
    ) : (
      <p className="muted">Loading…</p>
    );
  const turns = res.data.turnUsage.find((u) => u.agentId === row.id)?.turns ?? [];
  if (turns.length === 0) return <p className="muted">No turns recorded for {row.id} yet.</p>;
  const kinds = TURN_KINDS.map((k, i) => ({ ...k, color: agentColor(i) }));
  return (
    <div className="turns">
      <p className="muted">{row.id} · latest run · tokens per turn</p>
      <VBars
        label={`Tokens per turn, ${row.id}`}
        height={160}
        every={Math.max(1, Math.ceil(turns.length / 8))}
        format={kTokens}
        bars={turns.map((u, i) => ({
          key: String(i),
          label: `turn ${i + 1}`,
          tip: `turn ${i + 1}`,
          segments: kinds.map((k) => ({ name: k.label, value: u[k.key], color: k.color })),
        }))}
      />
      <Legend items={kinds.map((k) => ({ key: k.key, name: k.label, color: k.color }))} />
    </div>
  );
}
