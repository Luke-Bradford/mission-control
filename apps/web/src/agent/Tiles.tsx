import { type ContextUsage, type CrewRow, cacheHitPct, type LimitRow } from "@mc/core";
import { type ReactNode, useEffect, useRef } from "react";
import { useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import {
  contextPct,
  isFinishedWork,
  isSeatFree,
  runElapsed,
  SEAT_LAST_TICKET,
  seatActivity,
  seatTurn,
} from "../crew.ts";
import { hub, RESOURCES, SEAT_CONTEXT_REFRESH_MS, useResource } from "../data.ts";
import { cost, dur, kTokens, mss, rel } from "../fmt.ts";
import { Meter, meterLevel } from "../hud/Meter.tsx";
import { TicketRef } from "../hud/RepoRef.tsx";

const DASH = "—";
/** The mockup's `m:ss` reads badly past an hour (`160:48`); from there it is `2h 41m`. */
const HOUR_MS = 3_600_000;
const SPEED_PHASE = "Arrives with the agent runtime (phase 2).";

function Tile({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `tile2 ${className}` : "tile2"}>
      <span className="lbl">{label}</span>
      {children}
    </div>
  );
}

const k = (n: number): number => Math.round(n / 1000);

/** The tokens in a usage report's categories, by the tile's three groups and the rest. */
function splitUsage(u: ContextUsage) {
  let system = 0;
  let tools = 0;
  let msgs = 0;
  let other = 0;
  for (const c of u.categories) {
    if (c.name.includes("System prompt")) system += c.tokens;
    else if (/tool/i.test(c.name)) tools += c.tokens;
    else if (c.name === "Messages") msgs += c.tokens;
    else if (!/free/i.test(c.name)) other += c.tokens;
  }
  return { system, tools, msgs, other };
}

/** The compaction count; `—` while there is no digest to count from. */
const compactionsText = (d: CrewRow["digest"]): string =>
  d ? `${d.compactions} compaction${d.compactions === 1 ? "" : "s"}` : DASH;

/** A crew seat's Context tile: the CLI's own breakdown (`GET /api/seats/:id/context`). */
function SeatContext({ row }: { row: CrewRow }) {
  const ref = RESOURCES.seatContext(row.id);
  const usage = useResource<ContextUsage | null>(ref).data ?? null;
  const running = seatTurn(row) === "running";
  const wasRunning = useRef(running);
  // The last reading stays up in between; ask again every interval while running, once at turn end.
  useEffect(() => {
    if (wasRunning.current && !running) hub.refetch(ref.path);
    wasRunning.current = running;
    if (!running) return;
    const timer = setInterval(() => hub.refetch(ref.path), SEAT_CONTEXT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, ref.path]);
  const tail = compactionsText(row.digest);
  const window = usage?.window ?? row.contextWindow;
  if (!usage || window === null || window <= 0) {
    const pct = contextPct(row);
    return (
      <Tile label="Context">
        <span className="v num">
          {pct === null ? DASH : `${Math.round(pct)}%`}
          {pct !== null && row.contextWindow !== null && (
            <small> of {Math.round(row.contextWindow / 1000)}k</small>
          )}
        </span>
        <span className={`ctxbar${meterLevel(pct)}`}>
          {pct !== null && <i style={{ width: `${Math.min(100, pct)}%` }} />}
        </span>
        <span className="d">{tail}</span>
      </Tile>
    );
  }
  const pct = (100 * usage.total) / window;
  const s = splitUsage(usage);
  const seg = (cls: string, n: number) =>
    n > 0 && <i className={cls} style={{ width: `${Math.min(100, (100 * n) / window)}%` }} />;
  return (
    <Tile label="Context">
      <span className="v num">
        {Math.round(pct)}%<small> of {k(window)}k</small>
      </span>
      <span className="ctxbar seg">
        {seg("sys", s.system)}
        {seg("tools", s.tools)}
        {seg("msgs", s.msgs)}
        {seg("buf", s.other)}
      </span>
      <span className="d">
        msgs {k(s.msgs)}k · tools {k(s.tools)}k · system {k(s.system)}k · {tail}
      </span>
    </Tile>
  );
}

/** The header's tiles (catalogue 2.4.3), from the agent's latest run and its digest. */
export function Tiles({ row, limits, now }: { row: CrewRow; limits: LimitRow[]; now: number }) {
  const run = row.run;
  const d = row.digest;
  const pct = contextPct(row);
  const t = run?.tokens ?? null;
  const hit = t ? cacheHitPct(t) : null;
  const subs = d?.subagents.length ?? 0;
  const quota = limits.filter((l) => l.accountId === row.accountId);
  const elapsed = run ? runElapsed(run, now) : null;
  const tz = useTz();
  const running = run?.status === "running";
  /** The Now line's hover text: the ticket's title, else (no ticket, not running) the run's summary. */
  const nowTitle = row.ticket ? row.ticketTitle : running ? null : row.summary;
  const activity = seatActivity(row, now);

  return (
    <div className="tiles2">
      <Tile label="Now" className="now">
        <span className="s nowt" title={nowTitle ?? undefined}>
          {row.ticket && (isFinishedWork(row) || isSeatFree(row)) ? (
            <span className="muted" title={row.ticketTitle ?? undefined}>
              {SEAT_LAST_TICKET} <TicketRef ticket={row.ticket} bare />
            </span>
          ) : row.ticket ? (
            <>
              <TicketRef ticket={row.ticket} bare /> {row.ticketTitle}
            </>
          ) : row.summary && !running ? (
            <MarkdownInline text={row.summary} />
          ) : (
            <span className="muted">No ticket</span>
          )}
        </span>
        {activity && (
          <span className="d nowdoing" title={activity}>
            {activity}
          </span>
        )}
        <span className="d">
          {run && !running ? (
            <>
              last run #{run.seq} · took{" "}
              <span className="num">{elapsed === null ? DASH : dur(elapsed)}</span> · ended{" "}
              {run.endedAt !== null && tz ? rel(run.endedAt, now, tz) : DASH}
            </>
          ) : run ? (
            <>
              run #{run.seq} ·{" "}
              <span className="num">
                {elapsed === null ? DASH : elapsed < HOUR_MS ? mss(elapsed) : dur(elapsed)}
              </span>{" "}
              in this run
            </>
          ) : (
            "No runs yet"
          )}
        </span>
      </Tile>
      {row.kind === "crew" ? (
        <SeatContext key={row.id} row={row} />
      ) : (
        <Tile label="Context">
          <span className="v num">
            {pct === null ? DASH : `${Math.round(pct)}%`}
            {pct !== null && row.contextWindow !== null && (
              <small> of {Math.round(row.contextWindow / 1000)}k</small>
            )}
          </span>
          <span className={`ctxbar${meterLevel(pct)}`}>
            {pct !== null && <i style={{ width: `${Math.min(100, pct)}%` }} />}
          </span>
          <span className="d">
            Breakdown arrives with the agent runtime (phase 2) · {compactionsText(d)}
          </span>
        </Tile>
      )}
      <Tile label="Tokens this run">
        <span className="v num">{t ? kTokens(t.input + t.output) : DASH}</span>
        <span className="d">
          {t
            ? `${kTokens(t.input)} in · ${kTokens(t.output)} out · ${hit === null ? DASH : `${Math.round(hit)}%`} cache hit`
            : DASH}
        </span>
      </Tile>
      <Tile label="~Cost">
        <span className="v num">{cost(run?.costUsd ?? null)}</span>
        <span className="d">API-equivalent, this run</span>
      </Tile>
      <Tile label="Speed">
        <span className="v num" title={SPEED_PHASE}>
          {DASH}
          <small>tokens/s</small>
        </span>
        <span className="d">{SPEED_PHASE}</span>
      </Tile>
      <Tile label="Work">
        <span className="v num">
          {d ? d.toolCalls : DASH}
          <small>tool calls</small>
        </span>
        <span className="d">
          {d ? `${d.turns} turns · ${subs} subagent${subs === 1 ? "" : "s"}` : DASH}
        </span>
      </Tile>
      <Tile label={`Quota · ${row.accountId}`}>
        {quota.length > 0 ? (
          quota.map((l) => <Meter key={l.window} label={l.window} pct={l.used} />)
        ) : (
          <span className="d">No quota reading yet.</span>
        )}
      </Tile>
    </div>
  );
}
