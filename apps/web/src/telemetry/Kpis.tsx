import type { GuardHitsView, MetricId, Telemetry, TestLockHistory } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { useSecond } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { useSeatName } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { cost, dur, kTokens, mss, plural } from "../fmt.ts";
import { MetricName } from "../hud/MetricName.tsx";
import { metricText, metricTitle, sessionTag, useMetrics } from "../metrics.ts";
import { followLink } from "../router.ts";
import { DASH, NOT_TRACKED, NOT_TRACKED_TITLE } from "./common.ts";
import {
  GUARD_DRAWER_HREF,
  GUARD_TILE_LABEL,
  guardTileDetail,
  LOCK_TILE_FREE,
  LOCK_TILE_LABEL,
  lockFreeDetail,
  lockHolderDetail,
  topGuardRule,
} from "./guardCopy.ts";

interface Tile {
  key: string;
  label: string;
  value: string;
  detail: string;
  /** Moves with the crew today (the mockup's " ● live" marker). */
  live?: boolean;
  /** Why a `—` tile has no number yet. */
  title?: string;
  /** Where the tile's value links to. */
  href?: string;
  /** The figure is not stored: the value reads "not tracked yet", small and muted. */
  nt?: boolean;
  /** A registry figure (`METRICS` in @mc/core); its label carries the definition on hover. */
  metric?: MetricId;
  /** The label's hover text. */
  hint?: string;
  /** A registry figure's scope tag after its window ("s/mission-control"). */
  tag?: string | null;
}

function Kpi({ tile: k }: { tile: Tile }) {
  const previous = useRef(k.value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setChanged(
      !!k.live &&
        !k.nt &&
        k.value !== DASH &&
        previous.current !== DASH &&
        previous.current !== NOT_TRACKED &&
        previous.current !== k.value &&
        !motion?.matches,
    );
    previous.current = k.value;
    const stop = () => setChanged(false);
    motion?.addEventListener?.("change", stop);
    return () => motion?.removeEventListener?.("change", stop);
  }, [k.value, k.live, k.nt]);
  return (
    <div className={k.live ? "kpi live" : "kpi"}>
      <span className="lbl" title={k.hint}>
        {k.metric ? <MetricName id={k.metric} tag={k.tag} /> : k.label}
      </span>
      <span
        key={k.value}
        data-metric={k.metric}
        className={`v${k.nt ? " nt" : ""}${changed ? " kpi-change" : ""}`}
        title={k.title}
        onAnimationEnd={() => setChanged(false)}
      >
        {k.href === undefined ? (
          k.value
        ) : (
          <a href={k.href} onClick={(e) => followLink(e, k.href as string)}>
            {k.value}
          </a>
        )}
      </span>
      <span className="d">{k.detail}</span>
    </div>
  );
}

/**
 * Today's KPI row (catalogue 2.6.2). `live` (default true): the telemetry is fresh, so the tiles
 * that move with the crew today carry the live marker. Working, cost and merged are the registry's
 * figures; with an Agent, Account or Ticket filter set (`filtered`), working and cost show the
 * filtered figure under a label that says so instead.
 */
export function Kpis({
  t,
  live = true,
  filtered = false,
}: {
  t: Telemetry | undefined;
  live?: boolean;
  filtered?: boolean;
}) {
  const nameOf = useSeatName();
  const metrics = useMetrics();
  const r = metrics.readings;
  const d = t?.today;
  const hits = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const lock = useTestLock();
  const lockHistory = useResource<TestLockHistory>(RESOURCES.testLockHistory);
  const history = lockHistory.data;
  const now = useSecond();
  const blocked = hits ? Object.values(hits.counts).reduce((a, b) => a + b, 0) : null;
  const holder = lock?.holder ?? null;
  const num = (f: (x: NonNullable<typeof d>) => string): string => (d ? f(d) : DASH);
  const cpr = t?.quality.commitsPerRun;
  // `—` while loading; a figure the hub does not send is not tracked.
  const figure = (
    loaded: boolean,
    value: number | null | undefined,
    show: (n: number) => string,
  ): Pick<Tile, "value" | "title" | "nt"> =>
    !loaded
      ? { value: DASH }
      : value === undefined
        ? { value: NOT_TRACKED, title: NOT_TRACKED_TITLE, nt: true }
        : { value: value === null ? DASH : show(value) };
  const commits = figure(t !== undefined, d?.commits, String);
  if (d?.commits !== undefined)
    commits.title =
      cpr === undefined
        ? NOT_TRACKED_TITLE
        : cpr === null
          ? "No finished crew runs in the last 14 days."
          : `${cpr.toFixed(1)} per run, last 14 days`;
  // Telemetry's own figures ignore the header's session filter; a registry tile names the one it
  // follows, on its label and in its hover.
  const tag = sessionTag(metrics.session);
  const registry = (id: MetricId, detail: string): Tile => ({
    key: id,
    metric: id,
    label: metricText(id).label,
    tag,
    hint: `${metricTitle(metrics, id)}${tag ? `\nOn Telemetry this follows the header's session filter (${tag}); the page's own figures do not.` : ""}`,
    value: r[id]?.value ?? DASH,
    detail,
    live,
  });
  const filteredHint =
    "Only the agents, account or ticket picked above; the registry figure is shown unfiltered.";
  const tiles: Tile[] = [
    {
      key: "tokens",
      label: "Tokens",
      value: num((x) => kTokens(x.tokens)),
      detail: `today, in + out · ${num((x) => kTokens(x.cacheRead))} cache read`,
      live,
    },
    filtered
      ? {
          key: "cost",
          label: "~Cost · today · filtered",
          hint: filteredHint,
          value: num((x) => cost(x.costUsd)),
          detail: "API-equivalent",
          live,
        }
      : registry("cost", "API-equivalent"),
    {
      key: "tools",
      label: "Tool calls",
      value: num((x) => kTokens(x.toolCalls)),
      detail: `today · ${num((x) => kTokens(x.turns))} turns`,
      live,
    },
    {
      key: "commits",
      label: "Commits",
      detail: "today",
      live,
      ...commits,
    },
    filtered
      ? {
          key: "agentsWorking",
          label: "Working · now · filtered",
          hint: filteredHint,
          value: num((x) => String(x.working)),
          detail: d ? `of ${plural(d.agents, "agent")}` : `of ${DASH} agents`,
          live,
        }
      : registry("agentsWorking", r.agentsWorking?.detail ?? ""),
    {
      ...registry("merged", r.merged?.detail ? `PRs · ${r.merged.detail}` : "PRs"),
      live: false,
    },
    {
      key: "lock",
      label: "Lock wait",
      ...figure(history !== undefined || lockHistory.error !== null, history?.today.waitMs, mss),
      detail: history ? `today · ${plural(history.today.runs, "run")}` : "today",
    },
    {
      key: "capcom",
      label: "Your response",
      ...figure(t !== undefined, t?.capcom?.medianMs, dur),
      detail: "median, today",
    },
    {
      key: "guard",
      label: GUARD_TILE_LABEL,
      value: blocked === null ? DASH : String(blocked),
      detail: hits ? guardTileDetail(topGuardRule(hits.counts)) : "",
      href: GUARD_DRAWER_HREF,
    },
    {
      key: "testlock",
      label: LOCK_TILE_LABEL,
      value: lock === undefined ? DASH : holder ? nameOf(holder.seatId) : LOCK_TILE_FREE,
      detail:
        lock === undefined
          ? ""
          : holder
            ? lockHolderDetail(mss(now - holder.since), lock.waiting.length)
            : lockFreeDetail(lock.waiting.length),
    },
  ];
  return (
    <div className="kpis">
      {tiles.map((k) => (
        <Kpi key={k.key} tile={k} />
      ))}
    </div>
  );
}
