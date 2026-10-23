import { type GuardHitsView, seatCallSign, type Telemetry } from "@mc/core";
import { useSecond } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { cost, kTokens, mss } from "../fmt.ts";
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

/**
 * The KPI row (catalogue 2.6.2): today's numbers, scoped by the page's Agent and Account selects on the server. **Decision:** no tweening, and
 * Lock wait / Your response say "not tracked yet": Mission Control stores no figure for them.
 * Commits shows the hub's commits per run, `—` when no run finished in the window.
 */
export function Kpis({ t }: { t: Telemetry | undefined }) {
  const d = t?.today;
  const hits = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const lock = useTestLock();
  const now = useSecond();
  const blocked = hits ? Object.values(hits.counts).reduce((a, b) => a + b, 0) : null;
  const holder = lock?.holder ?? null;
  const num = (f: (x: NonNullable<typeof d>) => string): string => (d ? f(d) : DASH);
  const cpr = t?.quality.commitsPerRun;
  const commits: Pick<Tile, "value" | "title" | "nt"> = !t
    ? { value: DASH }
    : cpr === undefined
      ? { value: NOT_TRACKED, title: NOT_TRACKED_TITLE, nt: true }
      : cpr === null
        ? { value: DASH, title: "No finished crew runs in the last 14 days." }
        : { value: cpr.toFixed(1) };
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
      detail: cpr === undefined ? "today" : "per run, last 14 days",
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
      value: NOT_TRACKED,
      detail: "today",
      title: NOT_TRACKED_TITLE,
      nt: true,
    },
    {
      key: "capcom",
      label: "Your response",
      value: NOT_TRACKED,
      detail: "median, today",
      title: NOT_TRACKED_TITLE,
      nt: true,
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
