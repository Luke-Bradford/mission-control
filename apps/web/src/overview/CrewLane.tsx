// biome-ignore-all lint/a11y/useSemanticElements: ARIA table roles preserve the responsive CSS grid layout.
import type { CrewRow, OverviewTimeline } from "@mc/core";
import { kTokens } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";

export const LANE_MINUTES = 60;
const MINUTE_MS = 60_000;
const BAR_HEIGHT = 24;
const BAND_TOP = 27;
const BAND_HEIGHT = 4;

type Lane = OverviewTimeline["lanes"][number];
type SpanKind = Lane["spans"][number]["kind"];

/** What each band means, in the legend's order. */
export const LANE_KINDS: readonly { kind: SpanKind; label: string; color: string }[] = [
  { kind: "turn", label: "Working", color: "var(--accent)" },
  { kind: "checks", label: "Checks", color: "var(--ok)" },
  { kind: "lock", label: "Lock wait", color: "var(--warn)" },
  { kind: "review", label: "Review", color: "var(--think)" },
];

/** Tokens per minute for the last hour, ending at the shared panel clock. */
export function laneTokens(
  digest: CrewRow["digest"],
  now: number,
  lane?: Pick<Lane, "tokens">,
): number[] {
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  // The lane covers every run in the hour; a row's digest only covers its latest run.
  const buckets = new Map(lane?.tokens ?? digest?.minuteTokens ?? []);
  return Array.from(
    { length: LANE_MINUTES },
    (_, i) => buckets.get(end - (LANE_MINUTES - 1 - i) * MINUTE_MS) ?? 0,
  );
}

/** An open span says only that no end is recorded, so it counts as work only for a seat in a turn. */
const inTurn = (row: CrewRow): boolean => row.hudState === "running" || row.hudState === "stalled";

/** A seat's last hour on the crew's shared clock: tokens as bars, what it was doing as a band. */
export function CrewLane({
  row,
  name,
  lane,
  now,
  max,
  openEnd = now,
  known = true,
}: {
  row: CrewRow;
  name: string;
  lane: Lane | undefined;
  now: number;
  /** Where an open span stops being known: the last good reading when the feed has failed. */
  openEnd?: number;
  /** False while the activity feed has not loaded or could not load. */
  known?: boolean;
  /** The tallest minute on this seat's account: vendors count tokens on different scales. */
  max: number;
}) {
  const values = laneTokens(row.digest, now, lane);
  const from = now - LANE_MINUTES * MINUTE_MS;
  const x = (at: number) => (Math.max(0, at - from) / (LANE_MINUTES * MINUTE_MS)) * LANE_MINUTES;
  const spans = (lane?.spans ?? []).filter(
    (span) =>
      !(span.to === null && span.kind === "turn" && !inTurn(row)) && (span.to ?? openEnd) > from,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  const did = [...new Set(spans.map((span) => span.kind))]
    .map((kind) => LANE_KINDS.find((entry) => entry.kind === kind)?.label)
    .filter(Boolean)
    .join(", ");
  const label = `${name}, last hour: ${kTokens(total)} tokens · ${
    known ? did || "no recorded work" : "work not known"
  }`;
  return (
    <span role="cell" className="crew-lane">
      <svg
        viewBox={`0 0 ${LANE_MINUTES} 32`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        {values.map((value, i) => {
          if (value <= 0) return null;
          const height = Math.max(1, (value / Math.max(1, max)) * BAR_HEIGHT);
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: each index is a fixed minute of the hour
              key={i}
              className="crew-lane-bar"
              fill={agentColor(row.index)}
              x={i + 0.1}
              y={BAR_HEIGHT - height}
              width={0.8}
              height={height}
            />
          );
        })}
        {spans.map((span) => {
          const start = x(span.from);
          const end = x(span.to ?? openEnd);
          if (end <= start) return null;
          return (
            <rect
              key={`${span.kind}:${span.from}`}
              x={start}
              y={BAND_TOP}
              width={Math.max(0.5, end - start)}
              height={BAND_HEIGHT}
              fill={LANE_KINDS.find((entry) => entry.kind === span.kind)?.color}
            />
          );
        })}
      </svg>
    </span>
  );
}
