import type { AgentStream, AttentionItem, Crew, FlightSummaryView, FlightView } from "@mc/core";
import { isOperatorItem } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { runElapsed } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { dur, rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import type { NotificationsView } from "../notifications.ts";
import { navigate, PAGE_PATHS } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";
import { chatRows, dockRows } from "./conversation.ts";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";
import { SUMMARY_EMPTY } from "./Summary.tsx";
import { activeCrewRows } from "./WorkInFlight.tsx";

const DASH = "—";
type CommandTarget = "queue" | "record";
type PulseTarget = CommandTarget | "comms";

function pulseTone(value: number, risk = false): "ok" | "crit" | "plain" {
  if (value === 0) return "ok";
  return risk ? "crit" : "plain";
}

function LatestContact({ seatId }: { seatId: string | null | undefined }) {
  const stream = useResource<AgentStream>(seatId ? RESOURCES.stream(seatId) : null).data;
  const now = useSecond();
  const tz = useTz();
  const rows = chatRows(dockRows(stream, []));
  const latestYou = [...rows].reverse().find((row) => row.kind === "you");
  const latestFlight = [...rows].reverse().find((row) => row.kind === "flight");
  const replied =
    latestYou !== undefined &&
    latestFlight !== undefined &&
    latestYou.at !== null &&
    latestFlight.at !== null &&
    latestFlight.at >= latestYou.at;
  const waiting = latestYou !== undefined && !replied;
  const flightOnly = latestYou === undefined && latestFlight !== undefined;
  const latest = rows.at(-1);

  return (
    <div className="flight-contact">
      <div className="flight-contact-head">
        <span className="flight-source">LAST CONTACT</span>
        <Pill tone={waiting ? "warn" : replied ? "ok" : "plain"}>
          {waiting
            ? "Awaiting reply"
            : replied
              ? "Reply received"
              : flightOnly
                ? "FLIGHT updated"
                : "No exchange"}
        </Pill>
      </div>
      <p className="flight-contact-line">
        {seatId === undefined
          ? "Loading the current FLIGHT exchange…"
          : seatId === null
            ? FLIGHT_NO_SEAT
            : latest === undefined
              ? "No operator conversation in the current FLIGHT run."
              : `${latest.kind === "you" ? "You" : "FLIGHT"}: ${"text" in latest ? latest.text : ""}`}
      </p>
      <div className="flight-contact-foot">
        <span className="s fg2">
          {latest?.at === null || latest?.at === undefined || tz === null
            ? DASH
            : rel(latest.at, now, tz)}
        </span>
        <button type="button" className="sm ghost" onClick={() => navigate(PAGE_PATHS.comms)}>
          Open comms
        </button>
      </div>
    </div>
  );
}

/** The stand-up header: FLIGHT's judgement plus observed health, contact and forward load. */
export function Situation({ onOpen }: { onOpen?: (target: CommandTarget) => void }) {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary).data;
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const notifications = useResource<NotificationsView>(RESOURCES.notifications).data;
  const { inRepo, inView } = useSessionScope();
  const now = useSecond();
  const active = activeCrewRows(crew, inView);
  const blocked = active.filter(
    (row) =>
      ["blocked", "stalled", "parked", "error"].includes(row.hudState) ||
      row.loop?.phase === "parked",
  ).length;
  const scopedAttention = (attention ?? []).filter(
    (item) => item.repoId === null || inRepo(item.repoId),
  );
  const operatorItems = scopedAttention.filter(
    (item) => item.kind !== "person" && isOperatorItem(item),
  );
  const people = (notifications?.open ?? []).filter(
    (thread) =>
      inRepo(thread.repoId) &&
      !scopedAttention.some((item) => item.key === thread.key && !isOperatorItem(item)),
  );
  const needsYou = operatorItems.length + people.length;
  const reviewCi = (summary?.metrics.inReview ?? 0) + (summary?.metrics.inCi ?? 0);
  const oldestActive = active.reduce((oldest, row) => {
    const age = row.run ? runElapsed(row.run, now) : null;
    return age === null ? oldest : Math.max(oldest, age);
  }, 0);
  const headlineStale = (summary?.headlineAgeMin ?? 0) >= 60;
  const status =
    flight?.seat === null || flight?.seat?.live === false
      ? { label: "FLIGHT offline", tone: "crit" as const }
      : headlineStale
        ? { label: "Brief stale", tone: "warn" as const }
        : blocked > 0 || needsYou > 0
          ? { label: "Needs attention", tone: "warn" as const }
          : active.length > 0
            ? { label: "Work moving", tone: "ok" as const }
            : { label: "Standing by", tone: "plain" as const };
  const seatId = flight === undefined ? undefined : (flight.seat?.id ?? null);

  const pulse = (
    label: string,
    value: number | string,
    detail: string,
    tone: "ok" | "crit" | "plain",
    target?: PulseTarget,
  ) => {
    const content = (
      <>
        <span className="flight-pulse-value">{value}</span>
        <span className="flight-pulse-label">{label}</span>
        <span className="flight-pulse-detail">{detail}</span>
      </>
    );
    const action =
      target === "comms"
        ? () => navigate(PAGE_PATHS.comms)
        : target && onOpen
          ? () => onOpen(target)
          : null;
    return action ? (
      <button
        type="button"
        className={`flight-pulse ${tone}`}
        aria-label={`${label}: ${value} ${detail}`}
        onClick={action}
      >
        {content}
      </button>
    ) : (
      <div className={`flight-pulse ${tone}`}>{content}</div>
    );
  };

  return (
    <Panel
      id="sitP"
      className="flight-command-intent"
      title="FLIGHT briefing"
      sub="stand-up view · live"
    >
      <div className="flight-briefing">
        <div className="flight-intent-copy">
          <div className="flight-intent-kicker">
            <span className="flight-source">COMMANDER'S INTENT</span>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <p className="flight-intent-headline sittext">
            {summary ? summary.headline || SUMMARY_EMPTY : DASH}
          </p>
          <p className="s fg2 flight-headline-age">
            {summary?.session === null
              ? FLIGHT_NO_SEAT
              : summary?.headlineAgeMin === null || summary === undefined
                ? "FLIGHT has not refreshed this briefing yet."
                : summary.headlineAgeMin === 0
                  ? "Synthesised now"
                  : `Synthesised ${dur(summary.headlineAgeMin * 60_000)} ago`}
            {headlineStale && " · refresh required"}
          </p>
        </div>
        <LatestContact seatId={seatId} />
      </div>
      <div className="flight-pulse-rail">
        {pulse("WIP", active.length, "started, not finished", pulseTone(active.length))}
        {pulse("Blocked", blocked, "runs to clear", pulseTone(blocked, true))}
        {pulse(
          "Oldest",
          oldestActive === 0 ? DASH : dur(oldestActive),
          "active item age",
          blocked > 0 ? "crit" : "plain",
        )}
        {pulse("Review / CI", reviewCi, "delivery gates", pulseTone(reviewCi), "record")}
        {pulse(
          "Throughput",
          summary?.metrics.merged ?? 0,
          "merged / 24 h",
          pulseTone(summary?.metrics.merged ?? 0),
          "record",
        )}
        {pulse(
          "Cycle time",
          summary?.metrics.readyToMergedMin == null
            ? DASH
            : dur(summary.metrics.readyToMergedMin * 60_000),
          "median Ready → merged",
          "plain",
          "record",
        )}
        {pulse("Needs you", needsYou, "decisions or replies", pulseTone(needsYou, true), "comms")}
      </div>
    </Panel>
  );
}
