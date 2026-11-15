import type { FlightView } from "@mc/core";
import type { ReactNode } from "react";
import { useTz } from "../../clock.ts";
import { cost, hhmm, kTokens, rel } from "../../fmt.ts";
import type { FlightRun } from "../Situation.tsx";

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
  definition: string;
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

/**
 * Four tiles: FLIGHT running or stopped, cost per hour, sessions per hour and context size. A figure
 * the hub does not serve (null) says so rather than show 0.
 */
export function StatusBand({
  run,
  view,
  now,
}: {
  run: FlightRun;
  view: FlightView | undefined;
  now: number;
}) {
  const tz = useTz();
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
          sessionsHour.toLocaleString("en-GB")
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
