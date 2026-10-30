import {
  type AttentionItem,
  type CrewPause,
  FLIGHT_VIEW_LIMIT,
  type FlightSummaryView,
  type FlightWakeStatus,
  type MetricId,
  seatIsPaused,
} from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { dur, hhmm, rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { useMetrics } from "../metrics.ts";
import { stateWord } from "../shell/Dock.tsx";
import { type FlightSeat, type FlightView, flightOffText } from "./flightTypes.ts";
import { needsGroups } from "./needsGroups.ts";
import { SUMMARY_EMPTY } from "./Summary.tsx";
import type { FlightTab } from "./tabs.ts";

const DASH = "—";

/** One wake time as `14:02 · 3 min ago`; a dash while it or the timezone is unknown. */
const wakeAt = (at: number | null | undefined, now: number, tz: string | null): string =>
  at === null || at === undefined || tz === null
    ? DASH
    : `${hhmm(at, tz)} · ${at <= now ? rel(at, now, tz) : `in ${dur(at - now)}`}`;

/** The strip's wake line: last and next wake and what woke FLIGHT, a dash only for what is unknown. */
export function wakeLine(wake: FlightWakeStatus | undefined, now: number, tz: string | null) {
  const woke = wake?.wokeOn?.length ? wake.wokeOn.join(", ") : DASH;
  return `Last wake ${wakeAt(wake?.lastWakeAt, now, tz)} · next ${wakeAt(wake?.nextWakeAt, now, tz)} · woken on ${woke}`;
}
/** FLIGHT refreshes a headline at least hourly (central-mind spec), so an older one is stale. */
export const HEADLINE_STALE_MIN = 60;

export type FlightRun = { kind: "loading" } | { kind: "down" | "held" | "running"; why: string };

/**
 * Whether FLIGHT is running, held or down, and why in words. Held: the crew pause covers its seat,
 * or it is rate-limited. Down: no seat, or a stopped one that is neither.
 */
export function flightRun(
  view: FlightView | undefined,
  pause: CrewPause | null | undefined,
): FlightRun {
  if (view === undefined) return { kind: "loading" };
  const seat: FlightSeat | null = view.seat;
  if (seat === null) return { kind: "down", why: flightOffText(null) };
  // Held before down: the hub serves a rate-limited seat, and a paused one once its run ends, as
  // not live, but each is waiting to resume, not stopped.
  if (seatIsPaused(pause ?? null, seat.id))
    return { kind: "held", why: pause?.reason ? `crew paused: ${pause.reason}` : "crew paused" };
  if (seat.state === "parked") return { kind: "held", why: "rate-limited" };
  if (!seat.live) return { kind: "down", why: flightOffText(seat) };
  return { kind: "running", why: stateWord(seat) };
}

const RUN_LABEL = { down: "Down", held: "Held", running: "Running" } as const;
const RUN_TONE = { down: "crit", held: "warn", running: "ok" } as const;

/** One counter that opens the tab holding what it counts. */
function Counter({
  tab,
  label,
  n,
  warn = false,
  metric,
  onOpen,
}: {
  tab: FlightTab;
  label: string;
  n: number | string | null;
  warn?: boolean;
  /** The registry figure this counter shows, when it is one. */
  metric?: MetricId;
  onOpen: (tab: FlightTab) => void;
}) {
  return (
    <button
      type="button"
      className={`flight-counter${warn && n ? " tone-warn" : ""}`}
      onClick={() => onOpen(tab)}
      aria-label={`${label}: ${n ?? "loading"}`}
    >
      <b data-metric={metric}>{n ?? DASH}</b> {label}
    </button>
  );
}

/**
 * The FLIGHT page's situation: the one-line status over the tabs (the file keeps the name the hub's
 * Reader comments give it): whether FLIGHT is running, why, the crew pause, its last and
 * next wake, the headline with its age, and the three counts the tabs hold.
 */
export function StatusStrip({ onOpen }: { onOpen: (tab: FlightTab) => void }) {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const pause = useResource<CrewPause | null>(RESOURCES.crewPause).data;
  const summaryResource = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const summary = summaryResource.data;
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  // The registry figure, so the strip agrees with the header, Overview and Comms.
  const needsYou = useMetrics().readings.needsYou?.n ?? null;
  const now = useNow();
  const tz = useTz();
  const run = flightRun(flight.data, pause);
  const handling = attention === undefined ? null : needsGroups(attention).handling.length;
  const decidedN = flight.data?.decisions.length ?? null;
  // The hub serves at most FLIGHT_VIEW_LIMIT, so a full list is a floor, not a count.
  const decided =
    decidedN !== null && decidedN >= FLIGHT_VIEW_LIMIT ? `${FLIGHT_VIEW_LIMIT}+` : decidedN;
  const age = summary?.headlineAgeMin ?? null;
  const stale = age !== null && age >= HEADLINE_STALE_MIN;
  return (
    <section className="flight-strip" aria-label="FLIGHT status" data-testid="flight-strip">
      <span className="flight-strip-run">
        {run.kind === "loading" ? (
          <Pill tone="plain">…</Pill>
        ) : (
          <>
            <Pill tone={RUN_TONE[run.kind]}>{RUN_LABEL[run.kind]}</Pill>
            <span className="s">{run.why}</span>
          </>
        )}
      </span>
      {pause && (
        <span title={pause.reason}>
          <Pill tone="warn">Crew paused</Pill>
        </span>
      )}
      <span className="flight-strip-wake s">{wakeLine(flight.data?.wake, now, tz)}</span>
      <span className="flight-strip-headline min0">
        {flight.error && !flight.data ? (
          <span role="alert" className="crit-t">
            FLIGHT status unavailable: {flight.error.message}
          </span>
        ) : summary === undefined ? (
          summaryResource.error ? (
            <span role="alert" className="crit-t">
              FLIGHT summary unavailable: {summaryResource.error.message}
            </span>
          ) : (
            DASH
          )
        ) : summary.session === null ? (
          <span className="flight-gap">{flightOffText(flight.data?.seat ?? null)}</span>
        ) : (
          <>
            <MarkdownInline text={summary.headline || SUMMARY_EMPTY} max={140} />{" "}
            {age !== null && (
              <span className={stale ? "flight-gap" : "s"}>
                {age === 0 ? "now" : `${dur(age * 60_000)} old`}
                {stale && " · stale"}
              </span>
            )}
          </>
        )}
      </span>
      <span className="flight-strip-counters">
        <Counter
          tab="needs"
          label="Needs you"
          n={needsYou}
          warn
          metric="needsYou"
          onOpen={onOpen}
        />
        <Counter tab="needs" label="FLIGHT handling" n={handling} onOpen={onOpen} />
        <Counter tab="did" label="decided 24 h" n={decided} onOpen={onOpen} />
      </span>
    </section>
  );
}
