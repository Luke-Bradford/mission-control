import {
  type AttentionItem,
  type Crew,
  ENGINE_NOT_RUNNING,
  FLIGHT_NOT_RUNNING,
  type LimitRow,
} from "@mc/core";
import type { MouseEvent } from "react";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import {
  contextPct,
  crewOrder,
  doingLine,
  isFinishedWork,
  isLoopInFlight,
  isSeatFree,
  modelLine,
  needLine,
  needsLamp,
  SEAT_LAST_TICKET,
  seatStatus,
  sparkValues,
  tokensPerMinute,
} from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { cost, kTokens } from "../fmt.ts";
import { AgentTag, agentColor } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Meter } from "../hud/Meter.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { TicketRef } from "../hud/RepoRef.tsx";
import { Sparkline } from "../hud/Sparkline.tsx";
import { agentPath, followLink, navigate } from "../router.ts";
import { openItem, toggleDock } from "../shell/overlays.ts";
import { useSelectedAgent } from "../shell/selection.ts";
import { inSession, useSession } from "../shell/session.ts";
import { LoopStep } from "./LoopStep.tsx";

const DASH = "—";

function FlightRow() {
  const go = () => toggleDock(true);
  return (
    // As the agent rows: the call sign is the control, a click elsewhere on the row a mouse shortcut.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the call-sign button is the keyboard route
    // biome-ignore lint/a11y/noStaticElementInteractions: as above; the row is a container
    <div className="trow flight" onClick={go}>
      <span>
        <button
          type="button"
          className="rowlink"
          aria-label="FLIGHT, open the dock"
          onClick={(e) => {
            e.stopPropagation();
            go();
          }}
        >
          <AgentTag id="FLIGHT" index="flight" />
        </button>
        <span className="xs muted block">head agent</span>
      </span>
      <span>
        <Pill tone="neutral">Head</Pill>
      </span>
      <span className="min0">
        <span className="ellip s">{FLIGHT_NOT_RUNNING}</span>
      </span>
      <span className="xs fg2">{DASH}</span>
      <span className="tok">
        <span className="num s">{DASH}</span>
      </span>
      <span className="meters2">
        <span className="xs fg2">{DASH}</span>
      </span>
    </div>
  );
}

function AgentRow({
  row,
  items,
  limits,
  now,
  tz,
  selected,
}: {
  row: Crew["rows"][number];
  items: AttentionItem[];
  limits: LimitRow[];
  now: number;
  tz: string | null;
  selected: boolean;
}) {
  const mine = items.filter((i) => i.agentId === row.id);
  const repoPrs = useReviewPrs(row);
  const doing = doingLine(row, now, tz, repoPrs);
  const parts = needLine(row, items, now);
  const lamp = needsLamp(mine, true);
  const running = row.hudState === "running";
  const go = () => navigate(agentPath(row.id));
  const five = limits.find((l) => l.accountId === row.accountId && l.window === "5h");
  const tpm = tokensPerMinute(row.digest, now);
  const spark = sparkValues(row.digest);
  const tokens = row.run?.tokens ? row.run.tokens.input + row.run.tokens.output : null;
  const rate = [
    tpm === null ? null : `${kTokens(tpm)}/min`,
    row.run?.costUsd == null ? null : cost(row.run.costUsd),
  ].filter((x) => x !== null);
  const cls = ["trow", mine.length > 0 ? "needs" : running ? "going" : "", selected ? "sel" : ""];
  const click = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  const to = agentPath(row.id);
  return (
    // The row holds Answer/Open buttons, so it is not a button itself: the call sign is the link a
    // keyboard or screen reader uses, and a click anywhere else on the row is a mouse shortcut to it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the call-sign link is the keyboard route
    // biome-ignore lint/a11y/noStaticElementInteractions: as above; the row is a container
    <div
      className={cls.filter(Boolean).join(" ")}
      onClick={(e) => {
        // a link in the row (a ticket on GitHub) goes where it points, not to the Agent page
        if (!(e.target as Element).closest("a")) go();
      }}
    >
      <span>
        <a
          className="rowlink"
          href={to}
          onClick={(e) => {
            e.stopPropagation();
            followLink(e, to);
          }}
        >
          <AgentTag id={row.id} index={row.index} />
        </a>
        <span className="xs muted block" title={modelLine(row)}>
          {row.kind === "crew" ? `${row.role} · ${row.mode}` : `observed loop · ${row.loopKind}`}
        </span>
      </span>
      <span>
        <Pill tone={seatStatus(row).tone}>{seatStatus(row).label}</Pill>
      </span>
      <span className="min0">
        <span className="ellip s" title={row.ticket ? (row.ticketTitle ?? undefined) : undefined}>
          {row.ticket && isFinishedWork(row) ? (
            <span className="muted" title={row.ticketTitle ?? undefined}>
              {SEAT_LAST_TICKET} <TicketRef ticket={row.ticket} />
            </span>
          ) : row.ticket && !isSeatFree(row) ? (
            <>
              <TicketRef ticket={row.ticket} /> {row.ticketTitle}
            </>
          ) : (
            <span className="muted">No ticket</span>
          )}
        </span>
        <span className="ellip xs fg2 doing" title={doing}>
          <DoingLine row={row} now={now} tz={tz} repoPrs={repoPrs} />
        </span>
      </span>
      <span className="min0 loopstep">
        {row.loop && (row.kind !== "crew" || isLoopInFlight(row)) ? (
          <LoopStep loop={row.loop} hudState={row.hudState} />
        ) : (
          <span className="xs fg2" title={row.loop ? undefined : ENGINE_NOT_RUNNING}>
            {DASH}
          </span>
        )}
      </span>
      <span className="tok">
        <span className="row">
          <span className="num s">{tokens === null ? DASH : kTokens(tokens)}</span>
          <Sparkline values={spark} color={agentColor(row.index)} />
        </span>
        <span className="xs muted num">{rate.length > 0 ? rate.join(" · ") : DASH}</span>
      </span>
      <span className="meters2">
        <Meter label="ctx" pct={contextPct(row)} />
        <Meter label="5h" pct={five ? five.used : null} />
      </span>
      {parts.length > 0 && (
        <div className="need">
          {lamp && <Lamp {...lamp} />}
          {parts.map((p, i) => (
            <span key={p.key} className="needpart">
              {i > 0 && <span aria-hidden="true"> · </span>}
              <span>
                <MarkdownInline text={p.text} />
              </span>
              {p.action === null &&
                row.kind === "loop" &&
                mine.some((m) => m.key === p.key && m.kind === "stalled") && (
                  <span className="xs muted"> observed loop</span>
                )}
              {p.action !== null && (
                <>
                  {" "}
                  <button
                    type="button"
                    className={p.action === "answer" ? "sm primary" : "sm"}
                    onClick={click(() => openItem(p.key))}
                  >
                    {p.action === "answer" ? "Answer" : "Open"}
                  </button>
                </>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The crew (catalogue 2.1.2): FLIGHT first, then each observed loop. */
export function AgentsPanel() {
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const tz = useTz();
  const now = useSecond();
  const [session] = useSession();
  const [selected] = useSelectedAgent();
  const rows = crew.data
    ? crewOrder(
        crew.data.rows.filter((r) => inSession(session, r.repoId)),
        items,
      )
    : null;
  const working = rows?.filter((r) => r.hudState === "running").length ?? 0;

  return (
    <Panel
      id="agentsP"
      title="Agents"
      sub={rows ? `${working} working · ${rows.length} agents · FLIGHT not counted` : undefined}
    >
      <div
        className={rows && !rows.some((r) => r.loop) ? "scroll noloop" : "scroll"}
        id="agentsList"
      >
        <div className="trow head">
          <span>Agent</span>
          <span>State</span>
          <span>Ticket and what it's doing</span>
          <span>Loop step</span>
          <span className="right">Tokens · ~cost</span>
          <span>Context · quota</span>
        </div>
        <FlightRow />
        <CrewOff className="pb muted s" />
        {rows?.map((row) => (
          <AgentRow
            key={row.id}
            row={row}
            items={items}
            limits={limits}
            now={now}
            tz={tz}
            selected={row.id === selected}
          />
        ))}
        {crew.error && !rows && <div className="pb crit-t">Could not load the crew.</div>}
        {!rows && !crew.error && <div className="pb muted">Loading…</div>}
      </div>
    </Panel>
  );
}
