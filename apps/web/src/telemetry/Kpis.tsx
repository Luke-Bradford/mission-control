import { type GuardHitsView, seatCallSign, type Telemetry, type TestLockHistory } from "@mc/core";
import { useSecond } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { cost, dur, kTokens, mss } from "../fmt.ts";
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
}

/** Today's KPI row (catalogue 2.6.2). */
export function Kpis({ t }: { t: Telemetry | undefined }) {
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
  const tiles: Tile[] = [
    {
      key: "tokens",
      label: "Tokens",
      value: num((x) => kTokens(x.tokens)),
      detail: `today, in + out · ${num((x) => kTokens(x.cacheRead))} cache read`,
      live: true,
    },
    {
      key: "cost",
      label: "~Cost",
      value: num((x) => cost(x.costUsd)),
      detail: "today, API-equivalent",
      live: true,
    },
    {
      key: "tools",
      label: "Tool calls",
      value: num((x) => kTokens(x.toolCalls)),
      detail: `today · ${num((x) => kTokens(x.turns))} turns`,
      live: true,
    },
    {
      key: "commits",
      label: "Commits",
      detail: "today",
      ...commits,
    },
    {
      key: "working",
      label: "Working",
      value: num((x) => String(x.working)),
      detail: `now, of ${num((x) => String(x.agents))} agents`,
      live: true,
    },
    {
      key: "merged",
      label: "Merged",
      value: num((x) => String(x.merged7d)),
      detail: "PRs, last 7 days",
    },
    {
      key: "lock",
      label: "Lock wait",
      ...figure(history !== undefined || lockHistory.error !== null, history?.today.waitMs, mss),
      detail: history ? `today · ${history.today.runs} runs` : "today",
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
      value: lock === undefined ? DASH : holder ? seatCallSign(holder.seatId) : LOCK_TILE_FREE,
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
        <div key={k.key} className={k.live ? "kpi live" : "kpi"}>
          <span className="lbl">{k.label}</span>
          <span className={k.nt ? "v nt" : "v"} title={k.title}>
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
      ))}
    </div>
  );
}
