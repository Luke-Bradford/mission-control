import type { AttentionItem, CrewRow } from "@mc/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../clock.ts";
import { callSign, contextPct, needsLamp, seatStatus } from "../crew.ts";
import { dur, percent } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, navigate } from "../router.ts";
import { setSelectedAgent } from "../shell/selection.ts";
import { ListScrollCue } from "./ListScrollCue.tsx";

const roleOrder = (row: CrewRow): number => {
  const role = row.role?.toUpperCase() ?? row.loopKind.toUpperCase();
  if (role === "FLIGHT") return 0;
  if (role === "FAO" || role.includes("PLAN")) return 1;
  if (role === "RETRO" || role.includes("REVIEW")) return 3;
  return 2;
};

/** One fixed order drives the roster, keyboard selection and selected-seat reveal. */
export const compareRosterSeats = (a: CrewRow, b: CrewRow): number =>
  a.repoId.localeCompare(b.repoId) ||
  roleOrder(a) - roleOrder(b) ||
  callSign(a).localeCompare(callSign(b), undefined, { numeric: true });

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
  const [openRepos, setOpenRepos] = useState<Set<string>>(
    () => new Set(rows.map((row) => row.repoId)),
  );
  const groups = useMemo(() => {
    const byRepo = new Map<string, CrewRow[]>();
    for (const row of rows) byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row]);
    return [...byRepo.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, seats]) => [repo, [...seats].sort(compareRosterSeats)] as const);
  }, [rows]);
  useEffect(() => {
    const card = currentCard.current;
    const list = picker.current;
    if (!current || !card || !list) return;
    const reveal = () => {
      const bounds = list.getBoundingClientRect();
      const chosen = card.getBoundingClientRect();
      if (chosen.height === 0) return;
      if (chosen.top < bounds.top) list.scrollTop += chosen.top - bounds.top;
      else if (chosen.bottom > bounds.bottom) list.scrollTop += chosen.bottom - bounds.bottom;
    };
    reveal();
    // The scroll cue and loaded fonts can change the list after selection first renders.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    observer.observe(card);
    return () => observer.disconnect();
  }, [current]);
  useEffect(() => {
    const repo = rows.find((row) => row.id === current)?.repoId;
    if (repo) setOpenRepos((open) => (open.has(repo) ? open : new Set(open).add(repo)));
  }, [current, rows]);
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
            <details
              className="agent-roster-group"
              key={repo}
              open={openRepos.has(repo)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setOpenRepos((repos) => {
                  const next = new Set(repos);
                  if (open) next.add(repo);
                  else next.delete(repo);
                  return next;
                });
              }}
            >
              <summary className="agent-roster-group-title">
                <span>{repo}</span>
                <span className="mono muted">{seats.length}</span>
              </summary>
              {seats.map((row) => {
                const status = seatStatus(row);
                const context =
                  row.hudState === "idle" || row.run === null ? null : contextPct(row);
                const age =
                  row.lastOutputAt === null
                    ? "no output"
                    : `${dur(Math.max(0, now - row.lastOutputAt))} ago`;
                const work =
                  row.ticket !== null && row.ticketTitle
                    ? `${row.ticket} ${row.ticketTitle}`
                    : (row.ticket ?? row.summary ?? "Available for work");
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
                    aria-label={`${callSign(row)}, ${status.label}, ${work}`}
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
                    <span className="agent-roster-work" title={work}>
                      {work}
                    </span>
                    <span className="agent-roster-context">
                      <span>ctx</span>
                      <i>
                        <b
                          style={{ width: context === null ? "0%" : `${Math.min(100, context)}%` }}
                        />
                      </i>
                      <span>{percent(context)}</span>
                    </span>
                    <span
                      className="agent-roster-strip"
                      role="img"
                      aria-label="Activity in the last hour"
                    >
                      {(row.digest?.minuteTokens ?? [])
                        .filter(([at, tokens]) => tokens > 0 && at >= now - 3_600_000 && at <= now)
                        .map(([at]) => (
                          <i
                            key={at}
                            style={{
                              left: `${Math.max(0, Math.min(100, ((at - (now - 3_600_000)) / 3_600_000) * 100))}%`,
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
