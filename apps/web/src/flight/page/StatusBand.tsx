import type { FlightView } from "@mc/core";
import type { ReactNode } from "react";
import { useLocale, useTz } from "../../clock.ts";
import { cost, hhmm, kTokens, rel } from "../../fmt.ts";
import type { FlightRun } from "../Situation.tsx";
import {
  CHECKING,
  focusOf,
  NOTHING_WRONG,
  UNMEASURED,
  unknownText,
  VITAL_SHAPE,
  VITAL_WORD,
  type Vital,
} from "./vitals.ts";

export const NOT_RECORDED = "Not recorded yet";

const RUN_WORD = { down: "Stopped", held: "Held", running: "Running" } as const;
const RUN_TONE = { down: "stopped", held: "held", running: "running" } as const;

/** The tokens of FLIGHT's last turn against the size where it hands over, or null with no session. */
export function contextReading(
  view: FlightView | undefined,
): { tokens: number; limit: number; percent: number } | null {
  const c = view?.seat?.context;
  if (!c || c.tokens === null || c.rotateAt <= 0) return null;
  return {
    tokens: c.tokens,
    limit: c.rotateAt,
    percent: Math.round((c.tokens / c.rotateAt) * 100),
  };
}

function Stat({
  label,
  definition,
  meter,
  children,
}: {
  label: string;
  definition: ReactNode;
  /** A 0 to 100 reading drawn as a thin bar under the value. */
  meter?: number;
  children: ReactNode;
}) {
  return (
    <div className="fp-stat">
      <div className="fp-k">{label}</div>
      <div className="fp-v">{children}</div>
      {meter !== undefined && (
        <div className="fp-meter" aria-hidden="true">
          <i style={{ width: `${Math.min(100, meter)}%` }} />
        </div>
      )}
      <div className="fp-d">{definition}</div>
    </div>
  );
}

export const FOCUS_LABEL = "Focus now";

/** A state's shape and word, in its colour. */
function StateMark({ state }: { state: Vital["state"] }) {
  return (
    <span className="fp-vstate">
      <i className={`fp-shape ${VITAL_SHAPE[state]}`} aria-hidden="true" />
      {VITAL_WORD[state]}
    </span>
  );
}

/**
 * The worst bad or watch measure and its value, with a way down to every measure. With none
 * flagged, it says the measures are being checked, or how many have no figure, and is all clear
 * only when every measure is good.
 */
function Focus({ vitals }: { vitals: readonly Vital[] }) {
  const f = focusOf(vitals, UNMEASURED.length);
  const notes = [
    f.kind === "flagged" && f.more > 0 && `${f.more} more bad or on watch.`,
    f.kind === "flagged" && f.unknown > 0 && `${unknownText(f.unknown)}.`,
  ].filter(Boolean);
  return (
    <Stat
      label={FOCUS_LABEL}
      definition={
        <>
          {notes.length > 0 && `${notes.join(" ")} `}
          <a className="fp-focus-all" href="#roomP">
            All measures
          </a>
        </>
      }
    >
      {f.kind === "flagged" ? (
        <span className={`fp-focus fp-v-${f.worst.state}`}>
          <StateMark state={f.worst.state} /> {f.worst.label}
          <small>{f.worst.value}</small>
        </span>
      ) : f.kind === "loading" ? (
        <span className="fp-muted">{CHECKING}</span>
      ) : f.kind === "unknown" ? (
        <span className="fp-focus fp-v-none">
          <StateMark state="none" /> {unknownText(f.unknown)}
          <small>none bad or on watch</small>
        </span>
      ) : (
        <span className="fp-focus fp-v-ok">
          <StateMark state="ok" /> {NOTHING_WRONG}
        </span>
      )}
    </Stat>
  );
}

/**
 * Five tiles: FLIGHT running or stopped, the worst measure, cost per hour, sessions per hour and
 * context size. A figure the hub does not serve (null) says so rather than show 0.
 */
export function StatusBand({
  run,
  view,
  now,
  vitals,
}: {
  run: FlightRun;
  view: FlightView | undefined;
  now: number;
  /** Every measure, worst first. */
  vitals: readonly Vital[];
}) {
  const tz = useTz();
  const locale = useLocale();
  const ctx = contextReading(view);
  const last = view?.wake?.lastWakeAt ?? null;
  const lastWake =
    last !== null && tz !== null ? `Last woke ${hhmm(last, tz)} · ${rel(last, now, tz)}.` : "";
  const started = view?.runStartedAt ?? null;
  const runStart =
    started !== null && tz !== null
      ? `Run started ${hhmm(started, tz)} · ${rel(started, now, tz)}.`
      : "Run start not recorded yet.";
  const costHour = view?.costLastHour ?? null;
  const sessionsHour = view?.sessionsLastHour ?? null;
  const why = run.kind === "loading" ? "" : run.why.replace(/[.!?]+\s*$/, "");
  const state =
    run.kind === "loading" ? null : (
      <span className={`fp-state ${RUN_TONE[run.kind]}`}>{RUN_WORD[run.kind]}</span>
    );
  return (
    <section className="fp-band" aria-label="FLIGHT status" data-testid="flight-strip">
      <Stat
        label="FLIGHT"
        definition={
          run.kind === "loading"
            ? "Loading FLIGHT's state."
            : `${why.charAt(0).toUpperCase()}${why.slice(1)}. ${lastWake} ${runStart}`
        }
      >
        {state ?? <span className="fp-muted">…</span>}
      </Stat>
      <Focus vitals={vitals} />
      <Stat
        label="Cost per hour"
        definition="API-equivalent cost of FLIGHT's sessions over the last 60 minutes, in dollars. Not a bill."
      >
        {costHour === null ? <span className="fp-muted">{NOT_RECORDED}</span> : cost(costHour)}
      </Stat>
      <Stat
        label="Sessions per hour"
        definition="FLIGHT sessions started in the last 60 minutes. A handover starts a new one."
      >
        {sessionsHour === null ? (
          <span className="fp-muted">{NOT_RECORDED}</span>
        ) : (
          sessionsHour.toLocaleString(locale)
        )}
      </Stat>
      <Stat
        label="Context size"
        meter={ctx?.percent}
        definition="Tokens in the current session's latest reading, against the size where it hands over."
      >
        {ctx ? (
          <>
            {kTokens(ctx.tokens)}
            <small>
              of {kTokens(ctx.limit)} · {ctx.percent}%
            </small>
          </>
        ) : (
          <>
            —<small>no session open</small>
          </>
        )}
      </Stat>
    </section>
  );
}
