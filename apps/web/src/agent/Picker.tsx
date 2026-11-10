import type { AttentionItem, CrewRow } from "@mc/core";
import { useEffect, useMemo, useRef } from "react";
import { useNow } from "../clock.ts";
import { contextPct, needsLamp, seatStatus } from "../crew.ts";
import { dur } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, navigate } from "../router.ts";
import { setSelectedAgent } from "../shell/selection.ts";
import { ListScrollCue } from "./ListScrollCue.tsx";

const roleOrder = (row: CrewRow): number => {
  const role = row.role?.toLowerCase() ?? row.loopKind;
  if (role.includes("flight")) return 1;
  if (role.includes("plan")) return 2;
  if (role.includes("retro") || role.includes("review")) return 4;
  return 3;
};

/** The fixed-screen roster: grouped by repo, with each card carrying current work and session use. */
export function Picker({
  rows,
  items,
  current,
}: {
  rows: CrewRow[];
  items: AttentionItem[];
  current: string | null;
}) {
  const picker = useRef<HTMLFieldSetElement>(null);
  const currentCard = useRef<HTMLButtonElement>(null);
  const now = useNow();
  const groups = useMemo(() => {
    const byRepo = new Map<string, CrewRow[]>();
    for (const row of rows) byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row]);
    return [...byRepo.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([repo, seats]) =>
          [
            repo,
            [...seats].sort((a, b) => roleOrder(a) - roleOrder(b) || a.index - b.index),
          ] as const,
      );
  }, [rows]);
  useEffect(() => {
    if (current) currentCard.current?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  return (
    <aside className="panel agent-roster" aria-label="Seat roster">
      <div className="agent-roster-head">
        <b>Seats</b>
        <span className="muted mono">{rows.length}</span>
      </div>
      <ListScrollCue region={picker} label="seats" count={rows.length} />
      <fieldset className="agent-roster-list" ref={picker} aria-label="Pick an agent">
        {groups.map(([repo, seats]) => {
          return (
            <details className="agent-roster-group" key={repo} open>
              <summary className="agent-roster-group-title">
                <span>{repo}</span>
                <span className="mono muted">{seats.length}</span>
              </summary>
              {seats.map((row) => {
                const status = seatStatus(row);
                const context = contextPct(row);
                const age =
                  row.lastOutputAt === null
                    ? "no output"
                    : `${dur(Math.max(0, now - row.lastOutputAt))} ago`;
                const lamp = needsLamp(
                  items.filter((item) => item.agentId === row.id),
                  false,
                );
                return (
                  <button
                    key={row.id}
                    ref={row.id === current ? currentCard : undefined}
                    type="button"
                    className={`agent-roster-card${row.id === current ? " on" : ""}`}
                    aria-current={row.id === current ? "true" : undefined}
                    aria-pressed={row.id === current}
                    onClick={() => {
                      setSelectedAgent(row.id);
                      navigate(agentPath(row.id));
                    }}
                  >
                    <span className="agent-roster-card-line">
                      <span className="agent-roster-name">
                        {lamp && <Lamp {...lamp} />}
                        <AgentTag id={row.id} index={row.index} sm />
                      </span>
                      <span title={status.reason ?? status.label}>
                        <Pill tone={status.tone}>{status.label}</Pill>
                      </span>
                    </span>
                    <span className="agent-roster-age">{age}</span>
                    <span className="agent-roster-work" title={row.ticketTitle ?? undefined}>
                      {row.ticket ?? row.summary ?? "Available for work"}
                    </span>
                    <span className="agent-roster-context">
                      <span>ctx</span>
                      <i>
                        <b
                          style={{ width: context === null ? "0%" : `${Math.min(100, context)}%` }}
                        />
                      </i>
                      <span>{context === null ? "—" : `${Math.round(context)}%`}</span>
                    </span>
                    <span
                      className="agent-roster-strip"
                      role="img"
                      aria-label="Activity in the last hour"
                    >
                      {(row.events ?? [])
                        .filter((event) => event.at >= now - 3_600_000)
                        .map((event) => (
                          <i
                            key={`${event.kind}:${event.at}`}
                            style={{
                              left: `${Math.max(0, Math.min(100, ((event.at - (now - 3_600_000)) / 3_600_000) * 100))}%`,
                            }}
                          />
                        ))}
                    </span>
                  </button>
                );
              })}
            </details>
          );
        })}
      </fieldset>
    </aside>
  );
}
