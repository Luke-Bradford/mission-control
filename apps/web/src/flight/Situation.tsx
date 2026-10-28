import {
  type AgentStream,
  type FlightSummaryView,
  type FlightView,
  METRICS,
  type MetricId,
} from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { dur, rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { metricTitle, useMetrics } from "../metrics.ts";
import { navigate, PAGE_PATHS } from "../router.ts";
import { chatRows, dockRows } from "./conversation.ts";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";
import { SUMMARY_EMPTY } from "./Summary.tsx";

const DASH = "—";
/** Where a pulse leads: the canonical detail behind that reading. */
const PULSE_TARGET = {
  /** Plan's Operator actions: the operator's asks and drafts live there. */
  needs: `${PAGE_PATHS.flight}#askP`,
  /** Telemetry's flow of work shows cycle time over time. */
  cycle: PAGE_PATHS.telemetry,
} as const;
type PulseTarget = keyof typeof PULSE_TARGET;

type PulseTone = "crit" | "warn" | "plain";

/** Colour only where the reading is bad; no target is inferred, so nothing is ever "green". */
function pulseTone(value: number, bad: "crit" | "warn" | null = null): PulseTone {
  return value > 0 && bad !== null ? bad : "plain";
}

/** A reading with its units set smaller than its digits ("36h 34m"), as an instrument shows it. */
function Reading({ value }: { value: number | string }) {
  const text = String(value);
  const parts = [...text.matchAll(/([^a-zA-Z]*)([a-zA-Z]+)/g)];
  if (parts.length === 0) return <>{text}</>;
  // A duration's units ("h", "m", "s") appear once each, so each keys its part.
  return (
    <>
      {parts.map(([, digits, unit]) => (
        <span key={unit}>
          {digits}
          <span className="flight-unit">{unit}</span>
        </span>
      ))}
    </>
  );
}

/** FLIGHT's last message as one plain line: its first paragraph, with inline Markdown kept. */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

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
        <Pill tone={waiting ? "neutral" : replied ? "ok" : "plain"}>
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
        {seatId === undefined ? (
          "Loading the current FLIGHT exchange…"
        ) : seatId === null ? (
          FLIGHT_NO_SEAT
        ) : latest === undefined ? (
          "No operator conversation in the current FLIGHT run."
        ) : (
          <>
            <span className="flight-contact-who">{latest.kind === "you" ? "You" : "FLIGHT"}:</span>{" "}
            <MarkdownInline text={"text" in latest ? firstLine(latest.text) : ""} />
          </>
        )}
      </p>
      <div className="flight-contact-foot">
        <span className="flight-mono">
          {latest?.at === null || latest?.at === undefined || tz === null
            ? DASH
            : rel(latest.at, now, tz)}
        </span>
        <button
          type="button"
          className="sm ghost flight-link"
          onClick={() => navigate(PAGE_PATHS.comms)}
        >
          Open comms
        </button>
      </div>
    </div>
  );
}

/** The stand-up header: FLIGHT's judgement plus observed health, contact and forward load. */
export function Situation() {
  const summaryResource = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const summary = summaryResource.data;
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const now = useSecond();
  // The registry's figures (METRICS in @mc/core), so the rail agrees with every other page.
  const metrics = useMetrics();
  const { readings: r, view } = metrics;
  const blocked = r.blocked?.n ?? 0;
  const inProgress = r.inProgress?.n ?? 0;
  const needsYou = r.needsYou?.n ?? 0;
  // Two counts, not a sum: a PR in review can also have CI pending, so adding them double-counts.
  const inReview = summary?.metrics.inReview ?? 0;
  const inCi = summary?.metrics.inCi ?? 0;
  const oldestAt = view?.inProgress.oldestAt ?? null;
  const oldest = oldestAt === null ? 0 : Math.max(0, now - oldestAt);
  const headlineStale = (summary?.headlineAgeMin ?? 0) >= 60;
  // Operational state only: a stale briefing is FLIGHT's data quality, shown on the age line.
  const status =
    flight?.seat === null || flight?.seat?.live === false
      ? { label: "FLIGHT offline", tone: "crit" as const }
      : blocked > 0
        ? { label: "Blocked work", tone: "crit" as const }
        : needsYou > 0
          ? { label: "Needs you", tone: "warn" as const }
          : inProgress > 0
            ? { label: "Work moving", tone: "ok" as const }
            : { label: "Standing by", tone: "plain" as const };
  const seatId = flight === undefined ? undefined : (flight.seat?.id ?? null);

  const pulse = (
    label: string,
    value: number | string,
    detail: string,
    tone: PulseTone,
    window: string,
    target?: PulseTarget,
    metric?: MetricId,
  ) => {
    const idle = value === 0 || value === DASH;
    const content = (
      <>
        <span className="flight-pulse-value" data-metric={metric}>
          <Reading value={value} />
        </span>
        <span className="flight-pulse-label">{label}</span>
        <span className="flight-pulse-window" aria-hidden="true">
          {window}
        </span>
        <span className="flight-pulse-detail">{detail}</span>
      </>
    );
    // tone-* rather than bare crit/warn: a bare .warn on a button is the global warn button style.
    const cls = `flight-pulse tone-${tone}${idle ? " idle" : ""}`;
    const title = metric ? metricTitle(metrics, metric) : undefined;
    return target ? (
      <button
        type="button"
        className={cls}
        title={title}
        aria-label={`${label}: ${value} ${detail}, ${window}`}
        onClick={() => navigate(PULSE_TARGET[target])}
      >
        {content}
      </button>
    ) : (
      <div className={cls} title={title}>
        {content}
      </div>
    );
  };
  /** A registry figure: its label, window, value and hover come from the registry. */
  const figure = (id: MetricId, detail: string, tone: PulseTone = "plain", target?: PulseTarget) =>
    pulse(METRICS[id].label, r[id]?.value ?? DASH, detail, tone, METRICS[id].window, target, id);

  return (
    <Panel
      id="sitP"
      className="flight-briefing-panel"
      title="FLIGHT briefing"
      sub="stand-up view · live"
    >
      <div className="flight-briefing">
        <div className="flight-intent-copy">
          <div className="flight-intent-kicker">
            <span className="flight-source think">Commander's intent</span>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <p className="flight-intent-headline sittext">
            {summary ? summary.headline || SUMMARY_EMPTY : DASH}
          </p>
          {summaryResource.error && (
            // Live runs below come from the crew, so they stay current without the summary.
            <p role="alert" className="note err">
              FLIGHT summary unavailable: {summaryResource.error.message}
            </p>
          )}
          <p className="flight-headline-age">
            <span>
              {summary?.session === null
                ? FLIGHT_NO_SEAT
                : summary?.headlineAgeMin === null || summary === undefined
                  ? "FLIGHT has not refreshed this briefing yet."
                  : summary.headlineAgeMin === 0
                    ? "Synthesised now"
                    : `Synthesised ${dur(summary.headlineAgeMin * 60_000)} ago`}
            </span>
            {headlineStale && (
              <span className="flight-gap" title="FLIGHT refreshes a headline at least hourly">
                stale · refresh due
              </span>
            )}
          </p>
        </div>
        <LatestContact seatId={seatId} />
      </div>
      <div className="flight-pulse-rail">
        {figure("inProgress", "tickets started, not merged")}
        {figure("blocked", "agents to clear", pulseTone(blocked, "crit"))}
        {pulse(
          "Oldest",
          oldest === 0 ? DASH : dur(oldest),
          "in-progress ticket, since work started",
          "plain",
          "now",
        )}
        {pulse(
          "Review / CI",
          inReview + inCi === 0 ? 0 : `${inReview} / ${inCi}`,
          "PRs in review / CI pending",
          "plain",
          "now",
        )}
        {figure("merged", r.merged?.detail ? `PRs merged · ${r.merged.detail}` : "PRs merged")}
        {figure("cycleTime", `Ready → Done · ${r.cycleTime?.detail ?? DASH}`, "plain", "cycle")}
        {figure("needsYou", "decisions or replies", pulseTone(needsYou, "warn"), "needs")}
      </div>
    </Panel>
  );
}
