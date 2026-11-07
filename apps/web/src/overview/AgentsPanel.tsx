// biome-ignore-all lint/a11y/useSemanticElements: ARIA table roles preserve the responsive CSS grid layout.
import {
  type AttentionItem,
  type ConfigView,
  type Crew,
  FLIGHT_TICK_MS,
  type FlightBriefView,
  type OverviewTimeline,
  type RunLoop,
  type TestLockState,
} from "@mc/core";
import {
  type FocusEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { SeatControls } from "../agent/Header.tsx";
import { reviewPark, WaiveReviewFindings, WaiveReviewMenu } from "../agent/reviewPark.tsx";
import { useNow, useSecond, useSecondWhile, useTz } from "../clock.ts";
import { CrewPauseControl } from "../components/CrewPause.tsx";
import { useTestLock } from "../components/LockLines.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { NeedButton } from "../components/NeedButton.tsx";
import {
  callSign,
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
import { RESOURCES, streamStatus, useResource, useResources, useReviewPrs } from "../data.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "../flight/flightTypes.ts";
import { cutText, elapsed, kTokens, plural } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { metricTitle, useMetrics } from "../metrics.ts";
import { addAgentPath, agentPath, followLink, navigate } from "../router.ts";
import { openDockChat } from "../shell/overlays.ts";
import { useSelectedAgent } from "../shell/selection.ts";
import { useSessionScope } from "../shell/session.ts";
import { useStore } from "../shell/store.ts";
import { AgentCost } from "./AgentActivity.tsx";
import { ContextCapacity } from "./ContextCapacity.tsx";
import { CrewLane, LANE_KINDS, laneTokens } from "./CrewLane.tsx";
import { CrewOverflowNote } from "./CrewOverflowNote.tsx";
import { LoopStep } from "./LoopStep.tsx";
import { configuredAgents, OVERVIEW_LOADING_ROWS } from "./loading.ts";
import { useListFit } from "./useListFit.ts";

const DASH = "—";
/** Wide columns join when the table has room; the rest always show. */
const COLUMNS: readonly { label: string; title?: string; wide?: boolean; num?: boolean }[] = [
  { label: "State" },
  { label: "Seat" },
  { label: "Work" },
  { label: "Step", title: "Where the run is in its loop" },
  { label: "Last hour", title: "Tokens per minute over the work the seat was doing" },
  { label: "Tok 1h", title: "Input and output tokens in the last hour", num: true },
  { label: "Used", title: "Context used", wide: true, num: true },
  { label: "Limit", title: "Context limit", wide: true, num: true },
  { label: "Ctx", title: "Context used, percent of its limit", num: true },
  { label: "Cost", title: "Estimated run cost", wide: true, num: true },
  { label: "Out", title: "Time since the seat's last output", num: true },
];
/** Native focus scrolling cannot see a sticky cell painted over another control. */
function revealCrewFocus(event: FocusEvent<HTMLDivElement>) {
  const region = event.currentTarget,
    control = event.target;
  if (!(control instanceof HTMLElement) || region.scrollWidth <= region.clientWidth) return;
  requestAnimationFrame(() => {
    if (!region.isConnected || region.ownerDocument.activeElement !== control) return;
    const row = control.closest<HTMLElement>(".trow");
    // The State and Seat cells stay put while the rest scrolls; focus must land clear of both.
    const held = [...(row?.children ?? [])]
      .slice(0, 2)
      .filter((cell) => getComputedStyle(cell).position === "sticky");
    if (!row || !held.length || held.some((cell) => cell.contains(control))) return;
    const viewport = region.getBoundingClientRect(),
      target = control.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    const left =
      Math.max(viewport.left, ...held.map((cell) => cell.getBoundingClientRect().right)) + gap;
    const right = viewport.left + region.clientWidth - gap;
    if (target.left < left) region.scrollLeft -= left - target.left;
    else if (target.right > right) region.scrollLeft += target.right - right;
  });
}

const OPEN_RUN_LINE = "Run open, not in a turn";

/** The issue that pauses a watched loop; a link when the server knows its page, else plain text. */
function PausedBy({ by, url }: { by: string; url: string | null }) {
  return (
    <span className="ellip xs muted" title={`Paused by ${by}`}>
      Paused by{" "}
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {by}
        </a>
      ) : (
        by
      )}
    </span>
  );
}

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
  // The server supplies the oldest current-head queued review and its actual hold reason.
  // A paused seat alone is never enough to infer that a review is queued.
  if (row?.queuedReview && !row.reviewing) {
    const queued = row.queuedReview;
    return (
      <span
        role="cell"
        className="ellip s ticket-cell work-cell"
        title={`Queued review: ${queued.repoId}#${queued.prNumber} · ${queued.reason}`}
      >
        <span className="ellip">
          <RepoRef repoId={queued.repoId} number={queued.prNumber} kind="pr" bare />
          {" · "}
          {queued.reason}
        </span>
        {note}
        {actions}
      </span>
    );
  }
  if (!current) {
    // An open run on an idle session isn't in a turn, so it must not read as working on the ticket.
    // FLIGHT idling between checks and a paused seat's reason are not this case.
    const line =
      row?.hudState === "idle" &&
      hasActiveRun(row) &&
      row.loop &&
      row.role !== "FLIGHT" &&
      !row.crewPause &&
      !row.paused
        ? OPEN_RUN_LINE
        : doing;
    const refs = [row?.ticket?.replace(/^.*#/, "#"), prNumber ? `PR #${prNumber}` : null]
      .filter(Boolean)
      .join(" · ");
    return (
      <span role="cell" className="ellip s ticket-cell work-cell muted">
        {refs && <span className="ellip">last {refs}</span>}
        {note ??
          (row?.pausedBy ? (
            <PausedBy by={row.pausedBy} url={row.pausedByUrl ?? null} />
          ) : line || !refs ? (
            <span className="ellip xs muted" title={line}>
              {line || DASH}
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
        <span className="work-summary">
          <span className="work-refs">
            {row?.ticket && <TicketRef ticket={row.ticket} bare />}
            {prNumber && row && (
              <>
                {row.ticket && " · "}
                <RepoRef repoId={row.repoId} number={prNumber} kind="pr" bare />
              </>
            )}
            {!row?.ticket && !prNumber && DASH}
          </span>
          {(row?.ticket || prNumber) && title && (
            <span className="ellip" title={title}>
              {" · "}
              <span>{title}</span>
            </span>
          )}
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
  tz,
  configPending,
  selected,
  items,
  max,
  lock,
  lane,
}: {
  row: Crew["rows"][number] | null;
  lane: Lane | undefined;
  configPending: boolean;
  selected: boolean;
  tz: string | null;
  items: AttentionItem[];
  max: number;
  lock: TestLockState | undefined;
}) {
  const now = useSecondWhile(showsSeconds(row, lock), useNow());
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
  const go = openDockChat;
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
      <span role="cell" className={row ? "state-cell" : undefined} title={status?.reason ?? label}>
        {label && (
          <Pill tone={label === "Watching" ? "ok" : (status?.tone ?? "neutral")}>
            <span>{label}</span>
          </Pill>
        )}
        {row && row.stateSince > 0 && (
          <span className="xs muted num" title={sessionTurns}>
            {elapsed(now - row.stateSince)}
          </span>
        )}
      </span>
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
          head agent{row?.model ? ` · ${row.model}` : ""}
        </a>
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
      <RowMeasures row={row} name="FLIGHT" idle={DASH} lane={lane} max={max} />
    </div>
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

/** Clocks update the measured cells, leaving the roster structure and static controls alone. */
function AgentWork({
  row,
  items,
  lock,
  tz,
  rowElement,
  rowTitle,
}: {
  row: Crew["rows"][number];
  items: AttentionItem[];
  lock: TestLockState | undefined;
  tz: string | null;
  rowElement: RefObject<HTMLDivElement | null>;
  rowTitle?: string;
}) {
  const now = useSecondWhile(showsSeconds(row, lock), useNow());
  const prs = useReviewPrs(row);
  const doing = doingLine(row, now, tz, prs);
  // The native row tooltip belongs to this clock cell too. Updating its attribute keeps tool
  // durations current without rebuilding the row's controls or the roster on every second.
  useEffect(() => {
    if (rowElement.current) rowElement.current.title = rowTitle ?? doing;
  }, [doing, rowElement, rowTitle]);
  return (
    <WorkCell
      row={row}
      doing={doing}
      note={
        needLine(row, items, now, lock).length ? (
          <AgentNeeds row={row} items={items} now={now} lock={lock} />
        ) : undefined
      }
      actions={<ReviewParkSeatActions row={row} />}
    />
  );
}

type Lane = OverviewTimeline["lanes"][number];

/** Where the run is in its loop, or what the seat is when it has no run. */
function StepCell({ row, idle }: { row: Crew["rows"][number] | null; idle: string }) {
  // The same test the Work cell uses, so the two can't disagree about whether the seat is on it.
  if (row?.loop && hasActiveRun(row) && isCurrentWork(row))
    return (
      <span role="cell" className="step-cell">
        <LoopStep compact loop={row.loop} hudState={row.hudState} wait={null} />
      </span>
    );
  return (
    <span role="cell" className="step-cell xs muted">
      {idle}
    </span>
  );
}

/** The cells after Work. Clocks update only these, leaving the row's controls alone. */
function RowMeasures({
  row,
  name,
  idle,
  lane,
  max,
}: {
  row: Crew["rows"][number] | null;
  name: string;
  idle: string;
  lane: Lane | undefined;
  max: number;
}) {
  const now = useNow();
  const tokens = row
    ? laneTokens(row.digest, now, lane).reduce((sum, value) => sum + value, 0)
    : null;
  const timeline = useResource<OverviewTimeline>(RESOURCES.overviewTimeline);
  const connection = useStore(streamStatus);
  const stopped = timeline.error || (!connection.connected && connection.reconnecting);
  const openEnd = stopped && timeline.data ? Math.min(now, timeline.data.to) : now;
  // A later run's tokens are output too; `lastOutputAt` only knows the seat's latest run.
  const lastOutput = Math.max(row?.lastOutputAt ?? 0, lane?.tokens?.at(-1)?.[0] ?? 0);
  const run = row?.run;
  return (
    <>
      <StepCell row={row} idle={idle} />
      {row ? (
        <CrewLane
          row={row}
          name={name}
          lane={lane}
          now={now}
          max={max}
          openEnd={openEnd}
          known={timeline.data !== undefined}
        />
      ) : (
        <span role="cell">{DASH}</span>
      )}
      <span
        role="cell"
        className="num xs"
        title={
          run?.tokens
            ? `Input and output tokens in the last hour, across runs. This run: input ${kTokens(run.tokens.input)} · output ${kTokens(run.tokens.output)} · cache read ${kTokens(run.tokens.cacheRead)} · cache write ${kTokens(run.tokens.cacheCreate)}`
            : "Input and output tokens in the last hour"
        }
      >
        {tokens === null ? DASH : kTokens(tokens)}
      </span>
      <ContextCapacity row={row} />
      <AgentCost row={row} />
      <span role="cell" className="num xs" title="Time since the seat's last output">
        {lastOutput > 0 ? elapsed(Math.max(0, now - lastOutput)) : DASH}
      </span>
    </>
  );
}

function StateAge({ since }: { since: number }) {
  const now = useNow();
  return <span className="xs muted num">{since > 0 ? elapsed(now - since) : DASH}</span>;
}

function LockWaitTitleClock({
  row,
  lock,
  label,
  target,
}: {
  row: Crew["rows"][number];
  lock: TestLockState | undefined;
  label: string;
  target: RefObject<HTMLSpanElement | null>;
}) {
  const now = useSecond();
  const title = row.loop && waitText(row.loop, callSign(row), lockSince(lock, row.run?.id), now);
  useEffect(() => {
    if (target.current && title) {
      target.current.title = title;
      target.current.setAttribute("aria-label", `${label} · ${title}`);
    }
  }, [label, target, title]);
  return null;
}

function identityTitleAt(row: Crew["rows"][number], lock: TestLockState | undefined, now: number) {
  return [
    modelLine(row),
    ...(row.asideRuns ?? []).map((aside) => {
      const wait = waitText(aside.loop, callSign(row), lockSince(lock, aside.runId), now);
      return `${SET_ASIDE_LABEL}: ${aside.ticket ?? DASH} ${aside.ticketTitle ?? ""} · ${aside.loop.text}${wait ? ` · ${wait}` : ""}`;
    }),
  ].join("\n");
}

function AsideWaitTitleClock({
  row,
  lock,
  target,
}: {
  row: Crew["rows"][number];
  lock: TestLockState | undefined;
  target: RefObject<HTMLSpanElement | null>;
}) {
  const title = identityTitleAt(row, lock, useSecond());
  useEffect(() => {
    if (target.current) target.current.title = title;
  }, [target, title]);
  return null;
}

function AgentRow({
  row,
  items,
  max,
  tz,
  selected,
  lock,
  lane,
}: {
  row: Crew["rows"][number];
  lane: Lane | undefined;
  items: AttentionItem[];
  max: number;
  tz: string | null;
  selected: boolean;
  lock: TestLockState | undefined;
}) {
  const rowElement = useRef<HTMLDivElement>(null);
  const stateElement = useRef<HTMLSpanElement>(null);
  const identityElement = useRef<HTMLSpanElement>(null);
  const mine = seatItems(row, items);
  const now = Date.now();
  const repoPrs = useReviewPrs(row ?? undefined);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const roleTitle = seatRoleTitle(row.id, crew?.rows, config?.crew?.roles);
  const doing = doingLine(row, now, tz, repoPrs);
  const running = row.hudState === "running";
  const go = () => navigate(agentPath(row.id));
  const crewStatus = useResource<{ enabled: boolean }>(RESOURCES.crewStatus).data;
  const status = seatStatus(row);
  const queued = row.queuedReview && !row.reviewing;
  const statusLabel = queued
    ? "Queued"
    : row.crewPause
      ? status.label
      : lockSince(lock, row.run?.id) !== null
        ? "Watching"
        : status.label === "Free" && crewStatus?.enabled === false
          ? "Idle"
          : status.label;
  const statusTitle = queued
    ? row.queuedReview?.reason
    : row.crewPause
      ? status.reason
      : lockSince(lock, row.run?.id) !== null
        ? (row.loop && waitText(row.loop, callSign(row), lockSince(lock, row.run?.id), now)) ||
          "Waiting on test lock"
        : status.label === "Free" && crewStatus?.enabled === false
          ? "Crew is paused"
          : (status.reason ?? statusLabel);
  const cls = ["trow", mine.length > 0 ? "needs" : running ? "going" : "", selected ? "sel" : ""];

  const stateWaits =
    !queued && !row.crewPause && row.loop?.wait === "lock" && lockSince(lock, row.run?.id) !== null;
  const asideWaits = (row.asideRuns ?? []).some(
    (aside) => aside.loop.wait === "lock" && lockSince(lock, aside.runId) !== null,
  );
  const identityTitle = identityTitleAt(row, lock, now);
  const roleLabel =
    row.kind === "crew"
      ? `${roleTitle ?? row.role} · ${row.model ?? "model unknown"} · ${row.mode}`
      : `observed loop · ${row.loopKind}`;
  const to = agentPath(row.id);
  return (
    // The row holds Answer/Open buttons, so it is not a button itself: the call sign is the link a
    // keyboard or screen reader uses, and a click anywhere else on the row is a mouse shortcut to it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the call-sign link is the keyboard route
    // biome-ignore lint/a11y/useFocusableInteractive: the call-sign link provides keyboard access
    <div
      ref={rowElement}
      role="row"
      className={cls.filter(Boolean).join(" ")}
      title={status.label === "Free" && crewStatus?.enabled === false ? "Crew is paused" : doing}
      onClick={(e) => {
        // a link in the row (a ticket on GitHub) goes where it points, not to the Agent page
        if (!(e.target as Element).closest("a, button")) go();
      }}
    >
      <span
        ref={stateElement}
        role="cell"
        className="state-cell"
        title={statusTitle}
        aria-label={statusTitle ? `${statusLabel} · ${statusTitle}` : statusLabel}
      >
        {stateWaits && (
          <LockWaitTitleClock row={row} lock={lock} label={statusLabel} target={stateElement} />
        )}
        <Pill tone={status.tone}>
          <span>{statusLabel}</span>
        </Pill>
        <StateAge since={row.stateSince} />
      </span>
      <span ref={identityElement} role="cell" className="agent-identity" title={identityTitle}>
        {asideWaits && <AsideWaitTitleClock row={row} lock={lock} target={identityElement} />}
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
            ? [(roleTitle ?? row.role)?.replace(/ developer$/i, " dev").toLowerCase(), row.model]
                .filter(Boolean)
                .join(" · ")
            : `observed · ${row.repoId}`}
        </span>
      </span>
      <AgentWork
        row={row}
        items={items}
        lock={lock}
        tz={tz}
        rowElement={rowElement}
        rowTitle={
          status.label === "Free" && crewStatus?.enabled === false ? "Crew is paused" : undefined
        }
      />
      <RowMeasures
        row={row}
        name={callSign(row)}
        idle={row.kind === "loop" ? (mine.length ? needOwnerLabel(row, items) : "Observed") : DASH}
        lane={lane}
        max={max}
      />
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

/** From this many free seats the roster folds them into one row. */
export const FREE_SEATS_COLLAPSE_FROM = 2;

/** The folded free seats: how many, who, and a button that unfolds them into full rows. */
function FreeSeatsRow({
  rows,
  open,
  onToggle,
}: {
  rows: Crew["rows"];
  open: boolean;
  onToggle: () => void;
}) {
  const names = rows.map((row) => callSign(row)).join(", ");
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the toggle button inside is the focus target
    <div role="row" className="trow free-seats">
      <span role="cell">
        <button
          type="button"
          className="sm"
          aria-expanded={open}
          title={open ? "Fold the free seats" : "Show each free seat"}
          onClick={onToggle}
        >
          {rows.length} free {open ? "▴" : "▾"}
        </button>
      </span>
      <span role="cell" className="ellip muted" title={names}>
        {names}
      </span>
    </div>
  );
}

/** FLIGHT heads the crew, observed loops and stopped seats. */
export function AgentsPanel() {
  const scrollHint = useId();
  const rosterElement = useRef<HTMLDivElement>(null);
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const lock = useTestLock();
  const tz = useTz();
  // Reorder on source changes, not clock ticks. Each row owns its time-dependent text.
  const now = Date.now();
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

  // Crew seats and observed loops share the roster, in attention order.
  const seatRows = rows?.filter((r) => r.kind === "crew") ?? null;
  const loopRows = rows?.filter((r) => r.kind === "loop") ?? [];
  const seatCount = (seatRows?.length ?? 0) + (flight ? 1 : 0);
  const allRows = [...(flight ? [flight] : []), ...(rows ?? [])];
  const timeline = useResource<OverviewTimeline>(RESOURCES.overviewTimeline);
  const laneOf = (id: string) => timeline.data?.lanes.find((lane) => lane.agentId === id);
  // One scale per account: vendors count tokens differently, so a shared one flattens the smaller.
  const maxOf = (account: string | null | undefined) =>
    Math.max(
      1,
      ...allRows
        .filter((r) => r.accountId === account)
        .flatMap((r) => laneTokens(r.digest, now, laneOf(r.id))),
    );
  // A free seat has nothing to act on, so with several the roster folds them into one row. Seats that
  // work, wait, are blocked, carry a need or are selected stay full size.
  const [freeOpen, setFreeOpen] = useState(false);
  const isFree = (row: Crew["rows"][number]) =>
    row.kind === "crew" &&
    row.id !== selected &&
    seatStatus(row).label === "Free" &&
    seatItems(row, items).length === 0;
  const freeRows = rows?.filter(isFree) ?? [];
  const busyRows = rows?.filter((row) => !isFree(row));
  const renderRow = (row: Crew["rows"][number]) => (
    <AgentRow
      key={row.id}
      row={row}
      items={items}
      max={maxOf(row.accountId)}
      tz={tz}
      selected={row.id === selected}
      lock={lock}
      lane={laneOf(row.id)}
    />
  );
  useListFit(rosterElement, ".trow", `${rows?.length ?? -1}:${freeRows.length}:${freeOpen}`);
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
          {crew.data && (
            <span>
              {" "}
              · {plural(seatCount, "seat")}
              {loopRows.length ? ` · ${plural(loopRows.length, "observed loop")}` : ""}
            </span>
          )}
          <span title="FLIGHT first; then needs attention, running (most tokens in the last 10 minutes first), waiting, idle and stopped. Ties follow configured order.">
            · attention first ↓
          </span>
        </>
      }
      actions={
        <>
          <span className="lane-key" aria-hidden="true">
            {LANE_KINDS.map(({ kind, label, color }) => (
              <span key={kind}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
          </span>
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
      {crew.error && crew.data && (
        <p role="status" className="pb warn-t">
          Crew refresh failed. Showing the last received rows.
        </p>
      )}
      {timeline.error && (
        <p role="status" className="pb warn-t">
          {timeline.data
            ? "Activity refresh failed. Lanes show the last received hour."
            : "Activity could not load, so the lanes show tokens only."}
        </p>
      )}
      <CrewOverflowNote
        id={scrollHint}
        table={rosterElement}
        count={seatCount + loopRows.length}
        pending={!crew.data && !crew.error}
      />
      <div
        role="table"
        ref={rosterElement}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded roster supports keyboard scrolling.
        tabIndex={0}
        aria-label="Crew"
        aria-describedby={scrollHint}
        id="agentsList"
        onFocusCapture={revealCrewFocus}
        aria-busy={!crew.data && !crew.error}
      >
        {/* biome-ignore lint/a11y/useFocusableInteractive: table headers have no interaction */}
        <div className="trow head" role="row">
          {COLUMNS.map(({ label, title, wide, num }) => (
            // biome-ignore lint/a11y/useFocusableInteractive: these columns are not sortable
            <span
              role="columnheader"
              key={label}
              title={title ?? label}
              aria-label={label}
              className={[wide && "crew-wide", num && "num"].filter(Boolean).join(" ") || undefined}
            >
              {label === "Last hour" ? (
                <span className="lane-axis">
                  <span>−60m</span>
                  <span>−30m</span>
                  <span>now</span>
                </span>
              ) : (
                label
              )}
            </span>
          ))}
        </div>
        <FlightRow
          row={flight}
          selected={flight?.id === selected}
          configPending={!config && !configRes.error}
          items={items}
          max={maxOf(flight?.accountId)}
          tz={tz}
          lock={lock}
          lane={flight ? laneOf(flight.id) : undefined}
        />
        {busyRows?.map(renderRow)}
        {freeRows.length >= FREE_SEATS_COLLAPSE_FROM && (
          <FreeSeatsRow
            rows={freeRows}
            open={freeOpen}
            onToggle={() => setFreeOpen((open) => !open)}
          />
        )}
        {freeOpen || freeRows.length < FREE_SEATS_COLLAPSE_FROM ? freeRows.map(renderRow) : null}
        {crew.error && !rows && <div className="pb crit-t">Could not load the crew.</div>}
        {seatRows?.length === 0 && !flight && (
          <p className="pb">
            No crew seats are configured in this session. Add its first agent in Setup.
          </p>
        )}
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
              {COLUMNS.map(({ label: column, wide }) => (
                <span role="cell" key={column} className={wide ? "crew-wide" : undefined}>
                  <span className="kpi-skeleton" />
                </span>
              ))}
            </div>
          ))}
      </div>
    </Panel>
  );
}
