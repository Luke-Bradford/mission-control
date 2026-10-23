import {
  type AttentionItem,
  type ConfigView,
  type Crew,
  flightTurnShort,
  type LimitRow,
  type TestLockState,
} from "@mc/core";
import { SeatControls } from "../agent/Header.tsx";
import { useSecond, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { NeedButton } from "../components/NeedButton.tsx";
import {
  callSign,
  contextPct,
  crewOrder,
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
  sparkValues,
  tokensPerMinute,
  waitText,
} from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "../flight/flightTypes.ts";
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
import { toggleDock } from "../shell/overlays.ts";
import { useSelectedAgent } from "../shell/selection.ts";
import { inSession, useSession } from "../shell/session.ts";
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
  limits,
  now,
  tz,
  configPending,
}: {
  row: Crew["rows"][number] | null;
  /** The config that names the FLIGHT seat is still loading (no data, no error). */
  configPending: boolean;
  limits: LimitRow[];
  now: number;
  tz: string | null;
}) {
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const turns = flight?.seat?.turns ?? null;
  const go = () => toggleDock(true);
  const status = row ? seatStatus(row) : null;
  const five = row ? limits.find((l) => l.accountId === row.accountId && l.window === "5h") : null;
  const tpm = row ? tokensPerMinute(row.digest, now) : null;
  const tokens = row?.run?.tokens ? row.run.tokens.input + row.run.tokens.output : null;
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
          <AgentTag bare id="FLIGHT" index="flight" />
        </button>
        <span className="xs muted block">head agent</span>
      </span>
      <span>
        <Pill tone="neutral">Head</Pill>
        {status && <Pill tone={status.tone}>{status.label}</Pill>}
      </span>
      <span className="min0">
        {row ? (
          <span className="ellip xs fg2 doing" title={doingLine(row, now, tz, undefined)}>
            <DoingLine row={row} now={now} tz={tz} repoPrs={undefined} />
          </span>
        ) : configPending ? (
          <span className="ellip s muted">Loading…</span>
        ) : (
          <span className="ellip s">{FLIGHT_NO_SEAT}</span>
        )}
        <span className="xs muted block">coordinates the crew and brings you decisions</span>
      </span>
      <span className="xs fg2">{turns ? flightTurnShort(turns.n, turns.max) : DASH}</span>
      <span className="tok">
        <span className="num s">{tokens === null ? DASH : kTokens(tokens)}</span>
        {tpm !== null && <span className="xs muted num">{kTokens(tpm)}/min</span>}
      </span>
      <span className="meters2">
        {row ? (
          <>
            <Meter label="ctx" pct={contextPct(row)} />
            <Meter label="5h" pct={five ? five.used : null} />
          </>
        ) : (
          <span className="xs fg2">{DASH}</span>
        )}
      </span>
    </div>
  );
}

/** A need part whose button stops the seat's turn, so the row needs no second Interrupt. */
const stopsTheTurn = (p: NeedPart): boolean => p.action === "interrupt" || p.action === "stop";

function AgentRow({
  row,
  items,
  limits,
  now,
  tz,
  selected,
  lock,
}: {
  row: Crew["rows"][number];
  items: AttentionItem[];
  limits: LimitRow[];
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
  const doing = doingLine(row, now, tz, repoPrs);
  const parts = needLine(row, items, now, lock);
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
          <AgentTag bare id={row.id} index={row.index} />
        </a>
        <span className="xs muted block" title={modelLine(row)}>
          {row.kind === "crew"
            ? `${roleTitle ?? row.role} · ${row.mode}`
            : `observed loop · ${row.loopKind}`}
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
          <LoopStep
            loop={row.loop}
            hudState={row.hudState}
            wait={waitText(row.loop, callSign(row), lockSince(lock, row.run?.id), now)}
          />
        ) : (
          <span className="xs fg2" title={row.loop ? undefined : NO_LOOP}>
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
          <span className="muted">{SET_ASIDE_LABEL}</span>
          {a.ticket && <TicketRef ticket={a.ticket} />}
          {a.ticketTitle && (
            <span className="ellip" title={a.ticketTitle}>
              {a.ticketTitle}
            </span>
          )}
          <LoopStep
            loop={a.loop}
            hudState="idle"
            wait={waitText(a.loop, callSign(row), lockSince(lock, a.runId), now)}
          />
        </div>
      ))}
    </div>
  );
}

/** The crew (catalogue 2.1.2): FLIGHT first, then each observed loop. */
export function AgentsPanel() {
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const lock = useTestLock();
  const tz = useTz();
  const now = useSecond();
  const [session] = useSession();
  const [selected] = useSelectedAgent();
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const config = configRes.data;
  // The seat the server treats as FLIGHT has its own row above; any other lists as an agent.
  const flightId = flightSeatId(config);
  const flight = crew.data?.rows.find((r) => r.id === flightId) ?? null;
  const rows = crew.data
    ? crewOrder(
        crew.data.rows.filter((r) => r !== flight && inSession(session, r.repoId)),
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
        <FlightRow
          row={flight}
          configPending={!config && !configRes.error}
          limits={limits}
          now={now}
          tz={tz}
        />
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
            lock={lock}
          />
        ))}
        {crew.error && !rows && <div className="pb crit-t">Could not load the crew.</div>}
        {!rows && !crew.error && <div className="pb muted">Loading…</div>}
      </div>
    </Panel>
  );
}
