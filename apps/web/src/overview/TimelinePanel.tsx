import { type ConfigView, type Crew, type OverviewTimeline, TIMELINE_WINDOW_MS } from "@mc/core";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, streamStatus, useResource } from "../data.ts";
import { dur, elapsed } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink, PAGE_PATHS } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";
import { useStore } from "../shell/store.ts";
import { timelineGeometry } from "./chartGeometry.ts";
import { configuredAgents, OVERVIEW_LOADING_ROWS } from "./loading.ts";
import { OverviewOverflowNote } from "./OverviewOverflowNote.tsx";

/** Preserve a measured sub-minute interval instead of labelling it as zero minutes. */
const spanDuration = (ms: number) => (ms < 60_000 ? dur(ms) : elapsed(ms));

const COLORS = {
  turn: "var(--accent)",
  checks: "var(--ok)",
  lock: "var(--warn)",
  review: "var(--think)",
};

/** The axis labels and where they sit on the track (%), matching its 15-minute gridlines. */
const AXIS: [string, number][] = [
  ["-60m", 0],
  ["-45m", 25],
  ["-30m", 50],
  ["-15m", 75],
  ["now", 100],
];

/**
 * The last hour per agent: one thin sub-track per kind (turn, checks, lock, review) so overlapping
 * activity stays visible, 5- and 15-minute gridlines and a "now" cursor.
 */
export function TimelinePanel({
  footer,
  compact = false,
  onInspect,
  id: panelId = "timelineP",
}: {
  id?: string;
  footer?: ReactNode;
  compact?: boolean;
  onInspect?: () => void;
} = {}) {
  const id = useId();
  const scroll = useRef<HTMLElement>(null);
  const timeline = useResource<OverviewTimeline>(RESOURCES.overviewTimeline);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const roster = configuredAgents(config);
  const { inView, session } = useSessionScope();
  const connection = useStore(streamStatus);
  const now = useNow();
  const openEnd =
    (timeline.error || (!connection.connected && connection.reconnecting)) && timeline.data
      ? Math.min(now, timeline.data.to)
      : now;
  const from = now - TIMELINE_WINDOW_MS;
  const geometry = timelineGeometry({ from, to: now });
  const pending = !timeline.data && !timeline.error;
  const fallback =
    crew?.rows.map((row) => ({ id: row.id })) ??
    (config
      ? roster
      : Array.from({ length: OVERVIEW_LOADING_ROWS }, (_, i) => ({ id: `loading-${i}` })));
  const supplied =
    timeline.data?.lanes ??
    (pending ? fallback.map((agent) => ({ agentId: agent.id, spans: [], ticks: [] })) : []);
  const lanes = supplied.filter((lane) => {
    const row =
      crew?.rows.find((row) => row.id === lane.agentId) ??
      roster.find((row) => row.id === lane.agentId);
    return row ? inView(row) : session === "all";
  });
  let active = false;
  const records: { id: string; name: string; text: string }[] = [];
  const rows = lanes.map((lane) => {
    const name = roster.find((row) => row.id === lane.agentId)?.name;
    const agent = crew?.rows.find((row) => row.id === lane.agentId);
    const kinds = [...new Set(lane.spans.map((span) => span.kind))];
    const spans = lane.spans.flatMap((span) => {
      // An open turn says its end is unknown. A parked seat must not be painted as turning for the
      // whole view, but independent open activity (locks, checks and reviews) remains observable.
      if (span.to === null && span.kind === "turn" && agent?.hudState === "parked") return [];
      const start = Math.max(from, span.from);
      const end = Math.min(now, span.to ?? openEnd);
      if (end <= start) return [];
      active = true;
      const segment = geometry.segment(start, end);
      if (segment === null) return [];
      const description = `${span.kind} · ${spanDuration(end - start)} observed${span.to === null ? " · ongoing, end not recorded" : ""}`;
      return (
        <i
          key={`${span.kind}:${span.from}:${span.to}`}
          className={`overview-span k-${span.kind}`}
          title={description}
          data-span-label={`${span.kind} · ${spanDuration(end - start)}`}
          style={{
            left: `${segment.left}%`,
            width: `${segment.width}%`,
            background: COLORS[span.kind],
            top: `${kinds.indexOf(span.kind) * 16}px`,
          }}
        >
          <span>
            {span.kind} · {spanDuration(end - start)}
          </span>
        </i>
      );
    });
    const ticks = lane.ticks.filter((at) => at >= from && at <= now);
    if (ticks.length) active = true;
    const evidence =
      [
        ...lane.spans.map((span) => {
          if (span.to === null && span.kind === "turn" && agent?.hudState === "parked")
            return `turn: ${new Date(span.from).toISOString()} · end not recorded; seat parked, duration unknown`;
          const visibleMs = Math.max(
            0,
            Math.min(now, span.to ?? openEnd) - Math.max(from, span.from),
          );
          return `${span.kind}: ${new Date(span.from).toISOString()} to ${span.to === null ? "ongoing (end not recorded)" : new Date(span.to).toISOString()} · ${visibleMs > 0 ? `${spanDuration(visibleMs)} in this window` : "outside this window"}`;
        }),
        ...ticks.map(
          (at) => `Tool start: ${new Date(at).toISOString()} · instant, no duration recorded`,
        ),
      ].join("; ") || "No recorded intervals or tool starts in this window.";
    records.push({
      id: lane.agentId,
      name: agent ? callSign(agent) : (name ?? lane.agentId),
      text: evidence,
    });
    return (
      <TimelineLane
        key={lane.agentId}
        className="overview-lane"
        aria-label={agent ? callSign(agent) : (name ?? lane.agentId)}
        aria-describedby={`${id}-${lane.agentId}`}
        title={evidence}
        href={pending && !config && !crew ? undefined : agentPath(lane.agentId)}
        onClick={
          pending && !config && !crew ? undefined : (e) => followLink(e, agentPath(lane.agentId))
        }
      >
        <span
          className="num ellip"
          title={lane.agentId}
          style={{ "--c": agentColor(agent?.index ?? "flight") } as CSSProperties}
        >
          {agent ? callSign(agent) : (name ?? (pending ? "Loading…" : lane.agentId))}
        </span>
        <span
          className="overview-track"
          aria-hidden="true"
          style={{ height: `${Math.max(24, kinds.length * 16 + (ticks.length ? 16 : 0))}px` }}
        >
          {spans}
          {ticks.map((at, i) => (
            <i
              // biome-ignore lint/suspicious/noArrayIndexKey: multiple identical stateless marks can share the recorded millisecond.
              key={`${at}-${i}`}
              className="overview-instant"
              style={{ left: `${geometry.position(at)}%` }}
              title={`Tool start · ${new Date(at).toISOString()}`}
            >
              ◆
            </i>
          ))}
        </span>
        <span id={`${id}-${lane.agentId}`} className="sr-only">
          {evidence}
        </span>
      </TimelineLane>
    );
  });
  return (
    <Panel
      id={panelId}
      title="Timeline"
      sub="last 60 minutes · observed spans and tool starts"
      actions={
        <>
          {onInspect && (
            <button type="button" className="sm" onClick={onInspect}>
              {timeline.data ? `All ${lanes.length} lanes` : "All lanes"}
            </button>
          )}
          <a
            className="ph-link"
            href={PAGE_PATHS.map}
            title="Where in each repo the crew is working (g m)"
            onClick={(e) => followLink(e, PAGE_PATHS.map)}
          >
            Activity map →
          </a>
        </>
      }
    >
      <div className="pb timeline-body">
        <section
          className="overview-lane-scroll scroll"
          ref={scroll}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling keeps the shared axis visible.
          tabIndex={0}
          aria-label="Measured agent timeline"
        >
          <div className="overview-axis num muted">
            {AXIS.map(([label, left]) => (
              <span key={label} style={{ left: `${left}%` }}>
                {label}
              </span>
            ))}
          </div>
          <div
            className="overview-lanes"
            aria-busy={pending}
            style={{ "--lane-count": lanes.length } as CSSProperties}
          >
            {rows}
          </div>
        </section>
        <OverviewOverflowNote region={scroll} label="every measured timeline lane" compact />
        {timeline.error && timeline.data && (
          <p className="crit-t">Could not refresh timeline. Showing stale data.</p>
        )}
        {!timeline.data && (
          <p className={timeline.error ? "crit-t" : "muted"}>
            {timeline.error ? "Could not load timeline." : "Loading…"}
          </p>
        )}
        {timeline.data && !active && <p className="muted">No activity in the last hour.</p>}
        <div className={compact ? "timeline-key" : undefined}>
          <div className="overview-legend muted">
            {Object.entries(COLORS).map(([kind, color]) => (
              <span key={kind}>
                <i style={{ background: color }} />
                {kind}
              </span>
            ))}
            <span>
              {compact ? "◆ tool start (instant)" : "◆ tool start · no duration inferred"}
            </span>
          </div>
          {timeline.data && active && (
            <details className="overview-timeline-evidence">
              <summary>{compact ? "UTC intervals" : "Measured intervals · UTC"}</summary>
              <section
                className="scroll"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: complete measured evidence supports bounded keyboard scrolling.
                tabIndex={0}
                aria-label="Complete measured timeline evidence"
              >
                {records.map((record) => (
                  <p key={record.id}>
                    <b>{record.name}</b> · {record.text}
                  </p>
                ))}
              </section>
            </details>
          )}
        </div>
      </div>
      {footer}
    </Panel>
  );
}

/** Labels that do not fit their measured interval move to a readable companion line.
 * This reacts to track width, not guessed duration thresholds, and never invents a longer span.
 */
function TimelineLane(props: ComponentPropsWithoutRef<"a">) {
  const row = useRef<HTMLAnchorElement>(null),
    [outside, setOutside] = useState<string[]>([]);
  useTimelineLabels(row, setOutside);
  return (
    <a {...props} ref={row}>
      {props.children}
      {outside.length > 0 && (
        <span className="timeline-span-companions" aria-hidden="true">
          {outside.join(" · ")}
        </span>
      )}
    </a>
  );
}

function useTimelineLabels(
  row: RefObject<HTMLAnchorElement | null>,
  setOutside: Dispatch<SetStateAction<string[]>>,
) {
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const labels: string[] = [];
      for (const interval of element.querySelectorAll<HTMLElement>("[data-span-label]")) {
        const text = interval.querySelector<HTMLElement>("span");
        const fits = !!text && text.scrollWidth + 8 <= interval.clientWidth;
        interval.classList.toggle("span-label-outside", !fits);
        if (!fits && interval.dataset.spanLabel) labels.push(interval.dataset.spanLabel);
      }
      setOutside((previous) => (previous.join("\n") === labels.join("\n") ? previous : labels));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const track = element.querySelector(".overview-track");
    if (track) observer?.observe(track);
    const changes = new MutationObserver(measure);
    changes.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-span-label"],
    });
    measure();
    return () => {
      observer?.disconnect();
      changes.disconnect();
    };
  }, [row, setOutside]);
}
