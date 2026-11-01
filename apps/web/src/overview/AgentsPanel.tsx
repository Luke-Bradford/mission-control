// biome-ignore-all lint/a11y/useSemanticElements: ARIA table roles preserve the responsive CSS grid layout.
import {
  type AttentionItem,
  type ConfigView,
  type Crew,
  FLIGHT_TICK_MS,
  type FlightBriefView,
  type RunLoop,
  type TestLockState,
} from "@mc/core";
import type { ReactNode } from "react";
import { SeatControls } from "../agent/Header.tsx";
import { reviewPark, WaiveReviewFindings, WaiveReviewMenu } from "../agent/reviewPark.tsx";
import { useNow, useSecondWhile, useTz } from "../clock.ts";
import { CrewPauseControl } from "../components/CrewPause.tsx";
import { useTestLock } from "../components/LockLines.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { NeedButton } from "../components/NeedButton.tsx";
import {
  callSign,
  contextPct,
  crewOrder,
  doingLine,
  hasActiveRun,
  isCurrentWork,
  lockSince,
  modelLine,
  type NeedPart,
  needLine,
  needOwnerLabel,
  needsLamp,
  SET_ASIDE_LABEL,
  seatItems,
  seatRoleTitle,
  seatStatus,
  waitText,
} from "../crew.ts";
import { RESOURCES, useResource, useResources, useReviewPrs } from "../data.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "../flight/flightTypes.ts";
import { cutText, elapsed, plural } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Meter } from "../hud/Meter.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { metricTitle, useMetrics } from "../metrics.ts";
import { addAgentPath, agentPath, followLink, navigate } from "../router.ts";
import { toggleDock } from "../shell/overlays.ts";
import { useSelectedAgent } from "../shell/selection.ts";
import { useSessionScope } from "../shell/session.ts";
import { AgentActivity, AgentCost } from "./AgentActivity.tsx";
import { activityValues } from "./agentActivity.ts";
import { configuredAgents, OVERVIEW_LOADING_ROWS } from "./loading.ts";

const DASH = "—";
const COLUMNS = ["Agent", "State", "Work", "Tokens", "Cost", "Context", "In state"];
function WorkCell({
  row,
  doing,
  note,
  actions,
}: {
  row: Crew["rows"][number] | null;
  doing: string;
  note?: ReactNode;
  /** A row action that used to sit in the Loop column (the review-park waiver). */
  actions?: ReactNode;
}) {
  const prs = useReviewPrs(row ?? undefined);
  const prNumber =
    row?.reviewing?.prNumber ?? row?.loop?.prNumber ?? row?.review?.prNumber ?? row?.prs[0]?.number;
  const current = row && isCurrentWork(row);
  if (!current) {
    const refs = [row?.ticket?.replace(/^.*#/, "#"), prNumber ? `PR #${prNumber}` : null]
      .filter(Boolean)
      .join(" · ");
    return (
      <span role="cell" className="ellip s ticket-cell work-cell muted">
        {refs && <span className="ellip">last {refs}</span>}
        {note ??
          (doing || !refs ? (
            <span className="ellip xs muted" title={doing}>
              {doing || DASH}
            </span>
          ) : null)}
        {actions}
      </span>
    );
  }
  if (row?.reviewing) {
    return (
      <span role="cell" className="ellip s ticket-cell work-cell" title={doing}>
        <span className="ellip">
          {row.crewPause ? "Paused review" : "Checking"}{" "}
          <RepoRef repoId={row.repoId} number={row.reviewing.prNumber} kind="pr" bare />
          {row.reviewing.ref && (
            <>
              {" "}
              (<TicketRef ticket={row.reviewing.ref} bare />)
            </>
          )}
        </span>
        <span className="ellip xs muted" title={doing}>
          {doing}
        </span>
        {actions}
      </span>
    );
  }
  const title =
    row?.ticketTitle ||
    row?.prs.find((p) => p.number === prNumber)?.title ||
    prs?.find((p) => p.number === prNumber)?.title;
  const text =
    [
      row?.ticket?.replace(/^.*#/, "#"),
      prNumber ? `PR #${prNumber}` : null,
      row?.ticket || prNumber ? title : null,
    ]
      .filter(Boolean)
      .join(" · ") || DASH;
  return (
    <span role="cell" className="ellip s ticket-cell work-cell" title={text}>
      {(row?.ticket || prNumber || !note) && (
        <span className="ellip">
          {row?.ticket && <TicketRef ticket={row.ticket} bare />}
          {prNumber && row && (
            <>
              {row.ticket && " · "}
              <RepoRef repoId={row.repoId} number={prNumber} kind="pr" bare />
            </>
          )}
          {(row?.ticket || prNumber) && title && (
            <>
              {" "}
              · <span>{title}</span>
            </>
          )}
          {!row?.ticket && !prNumber && DASH}
        </span>
      )}
      {note ?? (
        <span className="ellip xs muted" title={doing}>
          {doing || DASH}
        </span>
      )}
      {actions}
    </span>
  );
}

/** The seat the server treats as FLIGHT: the first, in session then seat order, that is not retiring and runs the watch loop. */
function flightSeatId(config: ConfigView | undefined): string | null {
  for (const session of config?.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => !s.retiring && s.loop === "watch");
    if (seat) return seat.id;
  }
  return null;
}

/**
 * Whether a row's text counts seconds (a live tool, a stall, a wait for the test lock). Idle rows
 * show only minutes and so follow the panel's slower clock.
 */
const showsSeconds = (row: Crew["rows"][number] | null, lock: TestLockState | undefined): boolean =>
  row !== null &&
  row.run?.status === "running" &&
  (row.hudState === "running" ||
    row.hudState === "stalled" ||
    lockSince(lock, row.run.id) !== null);

/** The head agent's row: the live FLIGHT seat, or the placeholder while there is none. */
function FlightRow({
  row,
  now: coarseNow,
  tz,
  configPending,
  selected,
  items,
  max,
  lock,
}: {
  row: Crew["rows"][number] | null;
  configPending: boolean;
  selected: boolean;
  now: number;
  tz: string | null;
  items: AttentionItem[];
  max: number;
  lock: TestLockState | undefined;
}) {
  const now = useSecondWhile(showsSeconds(row, lock), coarseNow);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const brief = useResource<FlightBriefView>(RESOURCES.flightBrief).data;
  const turns = flight?.seat?.turns ?? null;
  const last = flight?.decisions.reduce<FlightView["decisions"][number] | null>(
    (a, b) => (!a || b.at > a.at ? b : a),
    null,
  );
  const status = row ? seatStatus(row) : null;
  const crewStatus = useResource<{ enabled: boolean }>(RESOURCES.crewStatus).data;
  const label = row?.crewPause
    ? status?.label
    : row?.hudState === "stopped"
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
  const nextCheck = row?.crewPause
    ? " · next check paused"
    : midTurn
      ? ""
      : label === "Held" || label === "Stopped"
        ? " · next check paused"
        : ` · next check within ${FLIGHT_TICK_MS / 60_000}m`;
  const openAsks = items.filter((i) =>
    ["question", "person", "decision", "approval"].includes(i.kind),
  ).length;
  const coverage = `watching ${brief?.watch?.length ?? 0} · triaging ${items.filter((i) => i.owner === "flight").length} · ${plural(openAsks, "open ask")} · ${last ? `last action ${elapsed(now - last.at)} ago (${cutText(last.about, 60)})` : "no action recorded"}${nextCheck}`;
  const sessionTurns = `Turns this session: ${turns?.n ?? DASH}`;
  const doing = row ? doingLine(row, now, tz, undefined) : "";
  const needs = row ? needLine(row, items, now, lock) : [];
  const go = () => toggleDock(true);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the call-sign button is the keyboard route
    // biome-ignore lint/a11y/useFocusableInteractive: the call-sign button provides keyboard access
    <div
      role="row"
      className={`trow flight${selected ? " sel" : ""}`}
      title={doing || (configPending ? "Loading…" : FLIGHT_NO_SEAT)}
      onClick={(e) => {
        if (!(e.target as Element).closest("a, button")) go();
      }}
    >
      <span role="cell" className="agent-identity" title={row ? modelLine(row) : undefined}>
        <button
          type="button"
          className="rowlink"
          aria-label="FLIGHT, open the dock"
          title="FLIGHT"
          onClick={go}
        >
          <AgentTag bare id="FLIGHT" index="flight" />
        </button>
        <a
          className="xs muted"
          href="/flight"
          onClick={(e) => followLink(e, "/flight")}
          title={`head agent · ${coverage} · ${last?.decision ?? "Open FLIGHT"} · ${sessionTurns}`}
        >
          head agent
        </a>
      </span>
      <span role="cell" className={row ? "state-cell" : undefined} title={status?.reason ?? label}>
        {label && (
          <Pill tone={label === "Watching" ? "ok" : (status?.tone ?? "neutral")}>
            <span>{label}</span>
          </Pill>
        )}
      </span>
      <WorkCell
        row={row}
        doing={doing}
        note={
          row && needs.length ? (
            <AgentNeeds row={row} items={items} now={now} lock={lock} />
          ) : undefined
        }
      />
      {row ? <AgentActivity row={row} now={now} max={max} /> : <span role="cell">{DASH}</span>}
      <AgentCost row={row} />
      <span role="cell" title="how full this agent's context window is">
        <Meter label="ctx" pct={row ? contextPct(row) : null} />
      </span>
      <span role="cell" className="num xs" title={sessionTurns}>
        {row && row.stateSince > 0 ? elapsed(now - row.stateSince) : DASH}
      </span>
    </div>
  );
}

/**
 * The observed loops (config.yaml loops, not crew seats) as one compact strip under the roster:
 * name, state in words and what step they are on. Each opens its Agent page.
 */
function LoopsStrip({
  rows,
  items,
  selected,
}: {
  rows: Crew["rows"];
  items: AttentionItem[];
  selected: string | null;
}) {
  if (rows.length === 0) return null;
  return (
    <nav className="loops-strip" aria-label="Loops">
      <strong>Loops</strong>
      {rows.map((row) => {
        const status = seatStatus(row);
        const asks = seatItems(row, items).length;
        const step = row.loop && hasActiveRun(row) ? row.loop.text : null;
        const to = agentPath(row.id);
        // A loop waiting on the operator says so in words and takes the warn colour.
        const tone = asks > 0 ? "warn" : status.tone;
        const state = asks > 0 ? needOwnerLabel(row, items) : status.label;
        return (
          <a
            key={row.id}
            className={`loop-chip tone-${tone}${row.id === selected ? " sel" : ""}`}
            href={to}
            title={[callSign(row), state, step, status.reason].filter(Boolean).join(" · ")}
            onClick={(e) => followLink(e, to)}
          >
            <span className="ellip">
              {callSign(row)} · {step ?? state}
            </span>
            {step && <span className="xs muted">{state}</span>}
          </a>
        );
      })}
    </nav>
  );
}

/** A need part whose button stops the seat's turn, so the row needs no second Interrupt. */
const stopsTheTurn = (p: NeedPart): boolean => p.action === "interrupt" || p.action === "stop";

function AgentNeeds({
  row,
  items,
  now,
  lock,
}: {
  row: Crew["rows"][number];
  items: AttentionItem[];
  now: number;
  lock: TestLockState | undefined;
}) {
  const mine = seatItems(row, items);
  const parts = needLine(row, items, now, lock);
  const lamp = needsLamp(
    mine,
    mine.some((i) => !i.acked),
  );
  if (parts.length === 0) return null;
  return (
    <span className="need">
      {lamp && <Lamp {...lamp} />}
      {parts.map((p, i) => (
        <span key={p.key} className="needpart">
          {i > 0 && <span aria-hidden="true"> · </span>}
          <span className="ellip" title={p.text}>
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
          <SeatControls row={row} interrupt={!parts.some(stopsTheTurn)} compact />
        </span>
      )}
    </span>
  );
}

function AgentRow({
  row,
  items,
  max,
  now: coarseNow,
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
  const now = useSecondWhile(showsSeconds(row, lock), coarseNow);
  const needs = needLine(row, items, now, lock);
  const repoPrs = useReviewPrs(row ?? undefined);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const roleTitle = seatRoleTitle(row.id, crew?.rows, config?.crew?.roles);
  const doing = doingLine(row, now, tz, repoPrs);
  const running = row.hudState === "running";
  const go = () => navigate(agentPath(row.id));
  const crewStatus = useResource<{ enabled: boolean }>(RESOURCES.crewStatus).data;
  const status = seatStatus(row);
  const statusLabel = row.crewPause
    ? status.label
    : lockSince(lock, row.run?.id) !== null
      ? "Watching"
      : status.label === "Free" && crewStatus?.enabled === false
        ? "Idle"
        : status.label;
  const statusTitle = row.crewPause
    ? status.reason
    : lockSince(lock, row.run?.id) !== null
      ? (row.loop && waitText(row.loop, callSign(row), lockSince(lock, row.run?.id), now)) ||
        "Waiting on test lock"
      : status.label === "Free" && crewStatus?.enabled === false
        ? "Crew is paused"
        : (status.reason ?? statusLabel);
  const cls = ["trow", mine.length > 0 ? "needs" : running ? "going" : "", selected ? "sel" : ""];

  const aside = row.asideRuns ?? [];
  const identityTitle = [
    modelLine(row),
    ...aside.map((a) => {
      const wait = waitText(a.loop, callSign(row), lockSince(lock, a.runId), now);
      return `${SET_ASIDE_LABEL}: ${a.ticket ?? DASH} ${a.ticketTitle ?? ""} · ${a.loop.text}${wait ? ` · ${wait}` : ""}`;
    }),
  ].join("\n");
  const roleLabel =
    row.kind === "crew"
      ? `${roleTitle ?? row.role} · ${row.mode}`
      : `observed loop · ${row.loopKind}`;
  const to = agentPath(row.id);
  return (
    // The row holds Answer/Open buttons, so it is not a button itself: the call sign is the link a
    // keyboard or screen reader uses, and a click anywhere else on the row is a mouse shortcut to it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the call-sign link is the keyboard route
    // biome-ignore lint/a11y/useFocusableInteractive: the call-sign link provides keyboard access
    <div
      role="row"
      className={cls.filter(Boolean).join(" ")}
      title={status.label === "Free" && crewStatus?.enabled === false ? "Crew is paused" : doing}
      onClick={(e) => {
        // a link in the row (a ticket on GitHub) goes where it points, not to the Agent page
        if (!(e.target as Element).closest("a, button")) go();
      }}
    >
      <span role="cell" className="agent-identity" title={identityTitle}>
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
        <span className="ellip xs muted" title={roleLabel}>
          {row.kind === "crew"
            ? (roleTitle ?? row.role)?.replace(/ developer$/i, "").toLowerCase()
            : row.loopKind}
        </span>
      </span>
      <span role="cell" className="state-cell" title={statusTitle}>
        <Pill tone={status.tone}>
          <span>{statusLabel}</span>
        </Pill>
      </span>
      <WorkCell
        row={row}
        doing={doing}
        note={
          needs.length ? <AgentNeeds row={row} items={items} now={now} lock={lock} /> : undefined
        }
        actions={<ReviewParkSeatActions row={row} />}
      />
      <AgentActivity row={row} now={now} max={max} />
      <AgentCost row={row} />
      <span role="cell" title="how full this agent's context window is">
        <Meter label="ctx" pct={contextPct(row)} />
      </span>
      <span role="cell" className="num xs">
        {row.stateSince > 0 ? elapsed(now - row.stateSince) : DASH}
      </span>
    </div>
  );
}

/** The overview keeps the explicit review waiver beside the parked seat, including set-aside runs. */
function ReviewParkSeatActions({ row }: { row: Crew["rows"][number] }) {
  const ids = [
    ...(row.loop?.phase === "parked" && row.run ? [row.run.id] : []),
    ...(row.asideRuns ?? []).filter((run) => run.loop.phase === "parked").map((run) => run.runId),
  ];
  const loops = useResources<{ loop: RunLoop | null }>(ids.map(RESOURCES.runLoop));
  const parks = ids.flatMap((runId, i) => {
    const park = reviewPark(loops[i]?.data?.loop);
    return park ? [{ runId, park }] : [];
  });
  if (parks.length === 0) return null;
  return (
    <span className="acts">
      {parks.length === 1 && (
        <WaiveReviewFindings runId={parks[0].runId} park={parks[0].park} compact />
      )}
      {parks.length > 1 && <WaiveReviewMenu parks={parks} />}
    </span>
  );
}

/** FLIGHT heads the crew, observed loops and stopped seats. */
export function AgentsPanel() {
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const lock = useTestLock();
  const tz = useTz();
  const now = useNow();
  const { inView: matchesSession } = useSessionScope();
  const [selected] = useSelectedAgent();
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const config = configRes.data;
  const firstSession = config?.crew?.sessions[0];
  // The seat the server treats as FLIGHT has its own row above; any other lists as an agent.
  const flightView = useResource<FlightView>(RESOURCES.flight).data;
  const flightId = flightView?.seat?.id ?? flightSeatId(config);
  const flight = crew.data?.rows.find((r) => r.id === flightId) ?? null;
  const rows = crew.data
    ? crewOrder(
        crew.data.rows.filter((r) => r !== flight && matchesSession(r)),
        items,
        now,
      )
    : null;
  // The registry's figure (every agent in view, FLIGHT and loops included), not this table's count.
  const metrics = useMetrics();
  const working = metrics.readings.agentsWorking;

  // Crew seats make the roster; observed loops sit in the Loops strip beneath it.
  const seatRows = rows?.filter((r) => r.kind === "crew") ?? null;
  const loopRows = rows?.filter((r) => r.kind === "loop") ?? [];
  const allRows = [...(flight ? [flight] : []), ...(rows ?? [])];
  const max = Math.max(1, ...allRows.flatMap((r) => activityValues(r.digest, now)));
  const placeholders = config
    ? configuredAgents(config).filter((agent) => agent.id !== flightId && matchesSession(agent))
    : Array.from({ length: OVERVIEW_LOADING_ROWS - 1 }, (_, i) => ({ id: `loading-${i}` }));
  return (
    <Panel
      id="agentsP"
      title="Crew"
      sub={
        <>
          {working ? (
            <span className="crew-working" title={metricTitle(metrics, "agentsWorking")}>
              <span data-metric="agentsWorking">{working.value}</span> {working.detail} working
            </span>
          ) : null}
          <CrewOff compact />
        </>
      }
      actions={
        <>
          <CrewPauseControl />
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
      <div role="table" aria-label="Crew" id="agentsList" aria-busy={!crew.data && !crew.error}>
        {/* biome-ignore lint/a11y/useFocusableInteractive: table headers have no interaction */}
        <div className="trow head" role="row">
          {COLUMNS.map((label) => (
            // biome-ignore lint/a11y/useFocusableInteractive: these columns are not sortable
            <span
              role="columnheader"
              key={label}
              title={label === "Tokens" ? "Tokens · last 30 minutes" : label}
            >
              {label}
            </span>
          ))}
        </div>
        <FlightRow
          row={flight}
          selected={flight?.id === selected}
          configPending={!config && !configRes.error}
          items={items}
          max={max}
          now={now}
          tz={tz}
          lock={lock}
        />
        {seatRows?.map((row) => (
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
        ))}
        {crew.error && !rows && <div className="pb crit-t">Could not load the crew.</div>}
        {!rows &&
          !crew.error &&
          placeholders.map((agent) => (
            // biome-ignore lint/a11y/useFocusableInteractive: loading rows have no actions
            <div
              className="trow crew-skeleton"
              role="row"
              key={agent.id}
              aria-label="Loading agent"
            >
              {COLUMNS.map((column) => (
                <span role="cell" key={column}>
                  <span className="kpi-skeleton" />
                </span>
              ))}
            </div>
          ))}
      </div>
      <LoopsStrip rows={loopRows} items={items} selected={selected} />
    </Panel>
  );
}
