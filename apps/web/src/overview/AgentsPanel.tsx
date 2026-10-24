import {
  type AttentionItem,
  type ConfigView,
  type Crew,
  FLIGHT_TICK_MS,
  type FlightBriefView,
  flightTurnShort,
  type LimitRow,
  type TestLockState,
} from "@mc/core";
import { SeatControls } from "../agent/Header.tsx";
import { isOperatorItem } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { NeedButton } from "../components/NeedButton.tsx";
import {
  callSign,
  contextPct,
  doingLine,
  isFinishedWork,
  isLoopInFlight,
  isSeatFree,
  lockSince,
  modelLine,
  type NeedPart,
  NO_LOOP,
  needLine,
  needsLamp,
  SEAT_LAST_TICKET,
  SET_ASIDE_LABEL,
  seatItems,
  seatRoleTitle,
  seatStatus,
  waitText,
} from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "../flight/flightTypes.ts";
import { cutText } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Meter } from "../hud/Meter.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { TicketRef } from "../hud/RepoRef.tsx";
import { firstWindow } from "../quota.ts";
import { addAgentPath, agentPath, followLink, navigate } from "../router.ts";
import { toggleDock } from "../shell/overlays.ts";
import { useSelectedAgent } from "../shell/selection.ts";
import { useSessionScope } from "../shell/session.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { AgentMetadata } from "./AgentMetadata.tsx";
import { activityValues, age, attentionOrder } from "./agentActivity.ts";
import { LoopStep } from "./LoopStep.tsx";

const DASH = "—";

/** The seat the server treats as FLIGHT: the first, in session then seat order, that is not retiring and runs the watch loop. */
function flightSeatId(config: ConfigView | undefined): string | null {
  for (const session of config?.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => !s.retiring && s.loop === "watch");
    if (seat) return seat.id;
  }
  return null;
}

/** The head agent's row: the live FLIGHT seat, or the placeholder while there is none. */
function FlightRow({
  row,
  now,
  tz,
  configPending,
  items,
  max,
}: {
  row: Crew["rows"][number] | null;
  configPending: boolean;
  now: number;
  tz: string | null;
  items: AttentionItem[];
  max: number;
}) {
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const brief = useResource<FlightBriefView>(RESOURCES.flightBrief).data;
  const turns = flight?.seat?.turns ?? null;
  const last = flight?.decisions.reduce<FlightView["decisions"][number] | null>(
    (a, b) => (!a || b.at > a.at ? b : a),
    null,
  );
  const status = row ? seatStatus(row) : null;
  const crewStatus = useResource<{ enabled: boolean }>(RESOURCES.crewStatus).data;
  const label =
    row?.hudState === "stopped"
      ? "Stopped"
      : row?.paused || (row && crewStatus?.enabled === false)
        ? "Held"
        : row?.hudState === "idle"
          ? "Watching"
          : row?.hudState === "running" || row?.hudState === "stalled"
            ? "Thinking"
            : row?.hudState === "parked"
              ? "Held"
              : status?.label;
  const midTurn = row?.hudState === "running" || row?.hudState === "stalled";
  const nextCheck = midTurn
    ? ""
    : label === "Held" || label === "Stopped"
      ? " · next check paused"
      : ` · next check within ${FLIGHT_TICK_MS / 60_000}m`;
  const coverage = `watching ${brief?.watch?.length ?? 0} · triaging ${items.filter((i) => i.owner === "flight").length} · ${items.filter((i) => ["question", "person", "decision", "approval"].includes(i.kind)).length} open asks · ${last ? `last action ${age(last.at, now)} ago (${cutText(last.about, 60)})` : "no action recorded"}${nextCheck}`;
  const sessionTurns = `Turns this session: ${turns?.n ?? DASH}`;
  const go = () => toggleDock(true);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the call-sign button is the keyboard route
    // biome-ignore lint/a11y/noStaticElementInteractions: the row is a container
    <div
      className="trow flight"
      onClick={(e) => {
        if (!(e.target as Element).closest("a, .agent-metadata, button")) go();
      }}
    >
      <span>
        <button type="button" className="rowlink" aria-label="FLIGHT, open the dock" onClick={go}>
          <AgentTag bare id="FLIGHT" index="flight" />
        </button>
        <span className="xs muted block">head agent</span>
      </span>
      <span className={row ? "state-cell" : undefined}>
        <Pill tone="neutral">Head</Pill>
        {label && (
          <Pill tone={label === "Watching" ? "ok" : (status?.tone ?? "neutral")}>
            <span>{label}</span>
            {row && row.stateSince > 0 && <span> · {age(row.stateSince, now)}</span>}
          </Pill>
        )}
      </span>
      <span className="agent-doing">
        {row ? (
          <span className="ellip xs fg2 doing" title={doingLine(row, now, tz, undefined)}>
            <DoingLine row={row} now={now} tz={tz} repoPrs={undefined} />
          </span>
        ) : (
          <span className="ellip s muted" title={configPending ? undefined : FLIGHT_NO_SEAT}>
            {configPending ? "Loading…" : FLIGHT_NO_SEAT}
          </span>
        )}
        <span
          className="xs muted block doing"
          title="coordinates the crew and brings you decisions"
        >
          coordinates the crew and brings you decisions
        </span>
      </span>
      <span className="xs fg2">{turns ? flightTurnShort(turns.n, turns.max) : DASH}</span>
      {row ? <AgentActivity row={row} now={now} max={max} /> : <span>{DASH}</span>}
      <span className="meters2" title="how full this agent's context window is">
        {row ? <Meter label="Context" pct={contextPct(row)} /> : DASH}
      </span>
      {row && (
        <div className="flight-coverage xs fg2">
          <span className="block" title={coverage}>
            {coverage}
          </span>
          <a
            className="ellip block"
            href="/flight"
            onClick={(e) => followLink(e, "/flight")}
            title={last?.decision ?? "Open FLIGHT"}
          >
            {last?.decision ?? "Open FLIGHT"}
          </a>
        </div>
      )}
      {row && <AgentMetadata row={row} sessionTurns={sessionTurns} />}
    </div>
  );
}

/** A need part whose button stops the seat's turn, so the row needs no second Interrupt. */
const stopsTheTurn = (p: NeedPart): boolean => p.action === "interrupt" || p.action === "stop";

function AgentRow({
  row,
  items,
  max,
  now,
  tz,
  selected,
  lock,
}: {
  row: Crew["rows"][number];
  items: AttentionItem[];
  max: number;
  now: number;
  tz: string | null;
  selected: boolean;
  lock: TestLockState | undefined;
}) {
  const mine = seatItems(row, items);
  const repoPrs = useReviewPrs(row);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const roleTitle = seatRoleTitle(row.id, crew?.rows, config?.crew?.roles);
  const shownLoop = row.loop && (row.kind !== "crew" || isLoopInFlight(row));
  const doingRow =
    shownLoop && row.digest?.liveTool ? { ...row, digest: { ...row.digest, liveTool: null } } : row;
  const doing = doingLine(doingRow, now, tz, repoPrs);
  const parts = needLine(row, items, now, lock);
  const lamp = needsLamp(
    mine,
    mine.some((i) => !i.acked),
  );
  const running = row.hudState === "running";
  const go = () => navigate(agentPath(row.id));
  const crewStatus = useResource<{ enabled: boolean }>(RESOURCES.crewStatus).data;
  const status = seatStatus(row);
  const statusLabel =
    lockSince(lock, row.run?.id) !== null
      ? "Waiting on lock"
      : status.label === "Free" && crewStatus?.enabled === false
        ? "Idle (crew paused)"
        : status.label;
  const cls = ["trow", mine.length > 0 ? "needs" : running ? "going" : "", selected ? "sel" : ""];

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
        if (!(e.target as Element).closest("a, .agent-metadata, button")) go();
      }}
    >
      <span>
        <a
          className="rowlink"
          title={callSign(row)}
          href={to}
          onClick={(e) => {
            e.stopPropagation();
            followLink(e, to);
          }}
        >
          <AgentTag bare id={row.id} index={row.index} />
        </a>
        <span className="xs muted block" title={modelLine(row)}>
          {row.kind === "crew"
            ? `${roleTitle ?? row.role} · ${row.mode}`
            : `observed loop · ${row.loopKind}`}
        </span>
      </span>
      <span className="state-cell">
        <Pill tone={status.tone}>
          <span>{statusLabel}</span>
          {row.stateSince > 0 && <span> · {age(row.stateSince, now)}</span>}
        </Pill>
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
        <span
          className="ellip xs fg2 doing"
          title={statusLabel === "Idle (crew paused)" ? "Crew is paused" : doing}
        >
          {statusLabel === "Idle (crew paused)" ? (
            "Crew is paused"
          ) : (
            <DoingLine row={doingRow} now={now} tz={tz} repoPrs={repoPrs} />
          )}
        </span>
      </span>
      <span className="min0 loopstep">
        {row.loop && (row.kind !== "crew" || isLoopInFlight(row)) ? (
          <LoopStep
            loop={row.loop}
            live={row.run?.status === "running" ? row.digest?.liveTool : null}
            now={now}
            hudState={row.hudState}
            wait={waitText(row.loop, callSign(row), lockSince(lock, row.run?.id), now)}
          />
        ) : (
          <span className="xs fg2" title={row.loop ? undefined : NO_LOOP}>
            {DASH}
          </span>
        )}
      </span>
      <AgentActivity row={row} now={now} max={max} />
      <span className="meters2" title="how full this agent's context window is">
        <Meter label="Context" pct={contextPct(row)} />
      </span>
      <AgentMetadata row={row} />
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
              <NeedButton part={p} row={row} />
            </span>
          ))}
          {row.kind === "crew" && (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the buttons inside are the keyboard route
            // biome-ignore lint/a11y/noStaticElementInteractions: a click on them must not open the Agent page
            <span className="needctl" onClick={(e) => e.stopPropagation()}>
              <SeatControls row={row} interrupt={!parts.some(stopsTheTurn)} />
            </span>
          )}
        </div>
      )}
      {(row.asideRuns ?? []).map((a) => (
        <div key={a.runId} className="asideline">
          <span className="muted">↳ {SET_ASIDE_LABEL}</span>
          <span className="xs muted">{a.stateSince ? age(a.stateSince, now) : DASH}</span>
          <span className="min0 ellip" title={a.ticketTitle ?? undefined}>
            {a.ticket && <TicketRef ticket={a.ticket} />} {a.ticketTitle}
          </span>
          <span className="min0 loopstep">
            <LoopStep
              loop={a.loop}
              hudState="idle"
              wait={waitText(a.loop, callSign(row), lockSince(lock, a.runId), now)}
            />
          </span>
          <AgentActivity
            row={{ ...row, events: a.events, digest: null }}
            now={now}
            max={max}
            eventsOnly
          />
          <span />
        </div>
      ))}
    </div>
  );
}

/** FLIGHT heads the crew, observed loops and stopped seats. */
export function AgentsPanel() {
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const lock = useTestLock();
  const tz = useTz();
  const now = useSecond();
  const { inView: matchesSession } = useSessionScope();
  const [selected] = useSelectedAgent();
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const config = configRes.data;
  const firstSession = config?.crew?.sessions[0];
  // The seat the server treats as FLIGHT has its own row above; any other lists as an agent.
  const flightId = flightSeatId(config);
  const flight = crew.data?.rows.find((r) => r.id === flightId) ?? null;
  const rows = crew.data
    ? attentionOrder(
        crew.data.rows.filter((r) => r !== flight && matchesSession(r)),
        items,
      )
    : null;
  const working = rows?.filter((r) => r.hudState === "running").length ?? 0;

  const allRows = [...(flight ? [flight] : []), ...(rows ?? [])];
  const max = Math.max(1, ...allRows.flatMap((r) => activityValues(r.digest, now)));
  const off = (r: Crew["rows"][number]) => r.hudState === "stopped" || r.paused;
  const groups = [
    { name: "Crew", rows: rows?.filter((r) => r.kind === "crew" && !off(r)) ?? [] },
    { name: "Observed loops", rows: rows?.filter((r) => r.kind === "loop" && !off(r)) ?? [] },
    { name: "Off", rows: rows?.filter(off) ?? [] },
  ];
  const accounts = [...new Set(allRows.map((r) => r.accountId))];
  return (
    <Panel
      id="agentsP"
      title="Agents"
      sub={rows ? `${working} working · ${rows.length} agents · FLIGHT not counted` : undefined}
      actions={
        <>
          {accounts.map((account) => {
            const quota = firstWindow(limits, account);
            return (
              <span className="agent-quota xs" key={account} title={`Account quota: ${account}`}>
                <span>{account}</span>
                <Meter label={quota?.window ?? "5h"} pct={quota?.used ?? null} />
              </span>
            );
          })}
          <button
            type="button"
            className="sm"
            disabled={!firstSession}
            onClick={() => firstSession && navigate(addAgentPath(firstSession.id))}
          >
            Add agent
          </button>
        </>
      }
    >
      <div className="scroll" id="agentsList">
        <div className="trow head">
          <span>Agent</span>
          <span>State</span>
          <span>Ticket and what it's doing</span>
          <span>Loop step</span>
          <span className="right">Progress · last 2h</span>
          <span>Context</span>
        </div>
        <FlightRow
          row={flight}
          configPending={!config && !configRes.error}
          items={items}
          max={max}
          now={now}
          tz={tz}
        />
        <CrewOff className="pb muted s" />
        {groups
          .filter((group) => group.rows.length > 0)
          .map((group) => {
            const needsYou = group.rows.filter((row) =>
              seatItems(row, items).some(isOperatorItem),
            ).length;
            const badge =
              needsYou > 0 ? (
                <Pill key={group.name} tone="warn">
                  Needs you · {needsYou}
                </Pill>
              ) : null;
            const children = group.rows.map((row) => (
              <AgentRow
                key={row.id}
                row={row}
                items={items}
                max={max}
                now={now}
                tz={tz}
                selected={row.id === selected}
                lock={lock}
              />
            ));
            return group.name === "Crew" ? (
              <section className="agent-group" aria-label={group.name} key={group.name}>
                <h3 className="agent-group-title">
                  Crew · {group.rows.length} {badge}
                </h3>
                {children}
              </section>
            ) : (
              <details
                className="agent-group"
                aria-label={group.name}
                key={group.name}
                open={group.name === "Observed loops" || needsYou > 0}
              >
                <summary className="agent-group-title">
                  {group.name} · {group.rows.length} {badge}
                </summary>
                {children}
              </details>
            );
          })}
        {crew.error && !rows && <div className="pb crit-t">Could not load the crew.</div>}
        {!rows && !crew.error && <div className="pb muted">Loading…</div>}
      </div>
    </Panel>
  );
}
