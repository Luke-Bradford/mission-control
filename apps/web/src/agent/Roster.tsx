import type { ConfigView, Crew, CrewRow, OverviewTimeline } from "@mc/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { callSign, seatRoleTitle, seatStatus } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { percent } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, navigate } from "../router.ts";
import { setSelectedAgent } from "../shell/selection.ts";
import {
  contextShown,
  hourMarks,
  rosterGroups,
  STRIP_KINDS,
  shortAge,
  workLine,
} from "./roster.ts";
import "./roster.css";

/** A context bar turns amber from here, as the mockup's marker line does. */
const CONTEXT_WARN_PCT = 75;

/**
 * Every seat the hub serves, by repo, each repo in the fixed seat order and foldable. The roster
 * scrolls inside its own frame and keeps the chosen seat in view; a click or Enter chooses a seat.
 */
export function Roster({ rows, current }: { rows: CrewRow[]; current: string | null }) {
  const roles = useResource<ConfigView>(RESOURCES.config).data?.crew?.roles;
  const all = useResource<Crew>(RESOURCES.crew).data?.rows;
  const lanes = useResource<OverviewTimeline>(RESOURCES.overviewTimeline).data?.lanes;
  const groups = useMemo(() => rosterGroups(rows), [rows]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const active = rows.filter((r) => r.hudState !== "idle" && r.hudState !== "stopped").length;
  const currentRepo = rows.find((r) => r.id === current)?.repoId ?? null;

  // Choosing a seat opens its group, even when it is in the repo already chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `current` is the trigger, not a value read.
  useEffect(() => {
    if (currentRepo === null) return;
    setFolded((f) => {
      if (!f.has(currentRepo)) return f;
      const next = new Set(f);
      next.delete(currentRepo);
      return next;
    });
  }, [current, currentRepo]);

  // ...and brings its card into the roster's own frame, never scrolling the page around it. A
  // frame that changes size (the dock opens, the window narrows) keeps the chosen seat in it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a card appears when its group unfolds.
  useEffect(() => {
    const frame = list.current;
    if (!frame) return;
    const keepInView = () => {
      const card = [...frame.querySelectorAll<HTMLElement>("[data-seat]")].find(
        (c) => c.dataset.seat === current,
      );
      if (!card) return;
      const f = frame.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      if (c.top < f.top) frame.scrollTop -= f.top - c.top;
      else if (c.bottom > f.bottom) frame.scrollTop += c.bottom - f.bottom;
    };
    keepInView();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(keepInView);
    watch.observe(frame);
    return () => watch.disconnect();
  }, [current, folded]);

  return (
    <aside className="panel roster" id="roster" aria-label="Crew roster">
      <div className="roster-head">
        <b>Crew</b>
        <span className="roster-count">
          {active} active · {rows.length} {rows.length === 1 ? "seat" : "seats"}
        </span>
      </div>
      <div className="roster-legend" title="Colours of the last-hour strip">
        {STRIP_KINDS.map((k) => (
          <span key={k}>
            <i className={`strip-${k}`} />
            {k}
          </span>
        ))}
      </div>
      <div className="roster-list" ref={list}>
        {groups.map((g) => {
          const open = !folded.has(g.repoId);
          return (
            <section key={g.repoId} className="roster-group" aria-label={g.repoId}>
              <button
                type="button"
                className="roster-fold"
                aria-expanded={open}
                onClick={() =>
                  setFolded((f) => {
                    const next = new Set(f);
                    if (open) next.add(g.repoId);
                    else next.delete(g.repoId);
                    return next;
                  })
                }
              >
                <span className="roster-chev" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <span className="roster-repo">{g.repoId}</span>
                <span className="roster-n">{g.rows.length}</span>
              </button>
              {open && (
                <div className="roster-cards">
                  {g.rows.map((r) => (
                    <SeatCard
                      key={r.id}
                      row={r}
                      on={r.id === current}
                      now={now}
                      lane={lanes?.find((l) => l.agentId === r.id)}
                      role={seatRoleTitle(r.id, all ?? rows, roles)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function SeatCard({
  row,
  on,
  now,
  lane,
  role,
}: {
  row: CrewRow;
  on: boolean;
  now: number;
  lane: OverviewTimeline["lanes"][number] | undefined;
  role: string | null;
}) {
  const status = seatStatus(row);
  const work = workLine(row);
  const ctx = contextShown(row);
  const marks = hourMarks(lane, now);
  const stripText =
    marks.length === 0
      ? "No activity in the last hour"
      : `${marks.length} marks of activity in the last hour`;
  const free = work.text === "Free";
  return (
    <button
      type="button"
      className={`seat-card${free ? " free" : ""}`}
      data-seat={row.id}
      aria-current={on}
      onClick={() => {
        setSelectedAgent(row.id);
        navigate(agentPath(row.id));
      }}
    >
      <span className="seat-bar" style={{ background: agentColor(row.index) }} aria-hidden="true" />
      <span className="seat-in">
        <span className="seat-r1">
          <span className="seat-id">
            <span className="seat-name">{callSign(row)}</span>
            {role && <span className="seat-role">{role}</span>}
          </span>
          <span title={status.reason ?? status.label}>
            <Pill tone={status.tone}>
              {status.label} · {shortAge(now - row.stateSince)}
            </Pill>
          </span>
        </span>
        <span className="seat-work" title={work.full}>
          {work.ticket && <span className="seat-tk">{work.ticket} </span>}
          {work.text}
        </span>
        <span className="seat-inst">
          <span className="seat-lbl">CTX</span>
          <span
            className="seat-meter"
            role="img"
            aria-label={ctx === null ? "Context not in use" : `Context ${ctx} percent used`}
          >
            {ctx !== null && (
              <b
                className={ctx >= CONTEXT_WARN_PCT ? "warn" : undefined}
                style={{ width: `${ctx}%` }}
              />
            )}
          </span>
          <span className="seat-v">{percent(ctx)}</span>
          <span className="seat-lbl">1 H</span>
          <span className="seat-strip" role="img" aria-label={stripText} title={stripText}>
            {marks.map((m) => (
              <i
                key={`${m.at}:${m.kind}`}
                className={`strip-${m.kind}`}
                style={{ left: `${m.at * 100}%`, width: `${m.len * 100}%` }}
              />
            ))}
          </span>
        </span>
      </span>
    </button>
  );
}
