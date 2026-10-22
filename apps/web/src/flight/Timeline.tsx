import type { ConfigView, HealthRow, LimitRow } from "@mc/core";
import type { CSSProperties } from "react";
import { useSecond, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm, wkdTime } from "../fmt.ts";
import { useChartWidth } from "../hud/charts/Hover.tsx";
import {
  labelSides,
  RIGHT_FROM,
  splitTimeline,
  TIMELINE_MINUTES,
  type TimelineEvent,
  upcoming,
} from "./timeline.ts";

const MIN = 60_000;

/** The next 240 minutes of what the server knows is coming, and a `Later:` line beyond. */
export function Timeline() {
  const now = useSecond();
  const tz = useTz();
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data;
  const health = useResource<HealthRow[]>(RESOURCES.health).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const poll = config?.poll;
  if (!tz || !limits || !health || !poll) return <p className="pb note">—</p>;
  const { onLine, later } = splitTimeline(
    upcoming({ now, limits, repoIds: config?.repos.map((r) => r.id) ?? [], health, poll }),
    now,
  );
  return <Line onLine={onLine} later={later} now={now} tz={tz} />;
}

function NextLine({
  className,
  events,
  tz,
}: {
  className: "wide" | "narrow";
  events: TimelineEvent[];
  tz: string;
}) {
  return (
    <div className={`tlnext ${className} s fg2`}>
      <b>Next:</b>{" "}
      {events.map((e, i) => (
        <span key={`${e.at}|${e.label}`}>
          {i > 0 && " · "}
          <b>{hhmm(e.at, tz)}</b> {e.label}
        </span>
      ))}
    </div>
  );
}

/** Mounted once the data is in, so the line's width is measured from its first render. */
function Line({
  onLine,
  later,
  now,
  tz,
}: {
  onLine: TimelineEvent[];
  later: TimelineEvent[];
  now: number;
  tz: string;
}) {
  const [lineRef, lineWidth] = useChartWidth(1100);
  const fracs = onLine.map((e) =>
    Math.min(1, Math.max(0, (e.at - now) / (TIMELINE_MINUTES * MIN))),
  );
  const text = (e: TimelineEvent): string => `${hhmm(e.at, tz)} ${e.label}`;
  const sides = labelSides(
    onLine.map((e, i) => ({ frac: fracs[i] ?? 0, chars: text(e).length })),
    lineWidth,
  );
  // Labels that found no room stay off the line; the wide Next list then carries just those.
  const crowded = sides.includes("none");
  return (
    <div className="pb">
      <div className="tl" id="timeline" ref={lineRef}>
        <div className="tlline" />
        <div className="tlnow">
          <span>now</span>
        </div>
        {onLine.map((e, i) => {
          const frac = fracs[i] ?? 0;
          const style = { left: `${frac * 100}%` } as CSSProperties;
          const side = sides[i] === "none" ? "dn bare" : sides[i];
          return (
            <div
              key={`${e.at}|${e.label}`}
              className={`tlev ${side}${frac > RIGHT_FROM ? " r" : ""}`}
              style={style}
              title={text(e)}
            >
              <i />
              <span>
                <b>{hhmm(e.at, tz)}</b> {e.label}
              </span>
            </div>
          );
        })}
      </div>
      {onLine.length > 0 && (
        // Two lists with real " · " text (so a copy keeps it); the CSS shows one: the narrow list
        // (every event) below 760px, else the wide one (only what the line left bare), if any.
        <>
          {crowded && (
            <NextLine
              className="wide"
              events={onLine.filter((_, i) => sides[i] === "none")}
              tz={tz}
            />
          )}
          <NextLine className="narrow" events={onLine} tz={tz} />
        </>
      )}
      {later.length > 0 && (
        <div className="tllater s fg2">
          <b>Later:</b>{" "}
          {later.map((e, i) => (
            <span key={`${e.at}|${e.label}`}>
              {i > 0 && " · "}
              <b>{wkdTime(e.at, tz)}</b> {e.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
