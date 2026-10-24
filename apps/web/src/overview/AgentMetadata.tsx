import type { CrewRow, RunLoopView } from "@mc/core";
import { useState } from "react";
import { Expandable } from "../components/Expandable.tsx";
import { loopTryText, modelLine } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { cost, kTokens } from "../fmt.ts";
import { PrChip } from "../hud/PrChip.tsx";

export function AgentMetadata({ row, wakeCount }: { row: CrewRow; wakeCount?: string }) {
  const [open, setOpen] = useState(false);
  const loop = useResource<RunLoopView>(
    open && row.run && row.loop ? RESOURCES.runLoop(row.run.id) : null,
  ).data;
  const t = row.run?.tokens;
  const tool = row.digest?.liveTool;
  const runCost =
    row.run?.status === "running" ? (row.run.costEstimateUsd ?? row.run.costUsd) : row.run?.costUsd;
  return (
    <details className="agent-metadata" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="xs muted">Run details</summary>
      {open && (
        <div className="xs fg2">
          <span>
            {modelLine(row)} · Account {row.accountId} · {row.digest?.turns ?? "—"} turns
            {wakeCount && ` · ${wakeCount}`}
          </span>
          <span className="block">
            Input {t ? kTokens(t.input) : "—"} · Output {t ? kTokens(t.output) : "—"} · Cache read{" "}
            {t ? kTokens(t.cacheRead) : "—"} · Cache write {t ? kTokens(t.cacheCreate) : "—"} · Cost{" "}
            {runCost == null ? "—" : cost(runCost)}
          </span>
          <Expandable lines={2}>
            <span title={row.ticketTitle ?? undefined}>
              Ticket: {row.ticketTitle ?? "No ticket"}
            </span>
            <span className="block">
              Current tool: {tool ? `${tool.name} ${tool.detail ?? ""}` : "None"}
            </span>
            {row.loop && (
              <span className="block">
                {row.loop.text}
                {loopTryText(row.loop)}
              </span>
            )}
          </Expandable>
          {row.loop && (
            <span className="block">
              Tries: {row.loop.tries ? `${row.loop.tries.n} of ${row.loop.tries.max}` : "—"} ·
              Rounds: {loop?.round ?? "—"}
            </span>
          )}
          <span className="row">
            {row.prs.map((pr) => (
              <PrChip key={`${pr.repoId}:${pr.number}`} pr={pr} />
            ))}
            {row.prs.length === 0 &&
              row.review &&
              `PR #${row.review.prNumber} · ${row.review.state}`}
          </span>
        </div>
      )}
    </details>
  );
}
