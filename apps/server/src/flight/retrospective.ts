import { join } from "node:path";
import {
  API_PREFIX,
  clockHm,
  FLIGHT_COSTLY_RUNS_MAX,
  FLIGHT_RETROSPECTIVE_SETTING,
  FLIGHT_RETROSPECTIVE_TIME,
  type FlightRetrospective,
  type FlightState,
  parkedEventText,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { originHeads } from "../mcp/tools.ts";
import { CREW_GIT_SLOW_MS } from "../runtime/checkouts.ts";
import { crewGit, crewGitBytes } from "../runtime/git.ts";
import type { Store } from "../store.ts";
import { flightMetrics } from "./ledger.ts";
import { flightSignalHistory } from "./signals.ts";
import { flightSeat } from "./state.ts";
import { cut } from "./tools.ts";

export const FLIGHT_RETROSPECTIVE_PRS_MAX = 100;
export const FLIGHT_RETROSPECTIVE_PARKS_MAX = 10;
export const FLIGHT_RETROSPECTIVE_REASON_MAX = 300;
export const SCREEN_WEB_DIR = "apps/web";
export const SCREEN_PATH_TABLE = `${SCREEN_WEB_DIR}/src/data.ts`;
export const SCREEN_SERVER_DIR = "apps/server/";
export const SCREEN_READER_ANNOTATION = /\/\/ Reader:.*apps\/web\//;
export const SCREEN_ROUTE_START = /^\s*api\.(?:get|post|put|patch|delete)\b/;
export const SCREEN_ROUTE_DECLARATION =
  /^(\s*)api\.(?:get|post|put|patch|delete)\b[^"']*["'](\/[^"']*)["']/;
const HUD_PRODUCT_PAGES = ["/", "/map", "/board", "/flight", "/telemetry", "/comms"];
const PRODUCT_PASS_INSTRUCTION =
  "Render each page at 1600×1000; compare it with the HUD mockup, direction and repo memory; file or fold gaps, then log pages checked and tickets filed or folded.";

type ScreenGit = (args: string[], input?: string) => Promise<string | Buffer>;

interface RetrospectiveRecord {
  day: string;
  told: boolean;
  report?: FlightRetrospective;
}
const setting = (repo: string): string => `${FLIGHT_RETROSPECTIVE_SETTING}:${repo}`;
const read = (store: Store, repo: string): RetrospectiveRecord | null => {
  try {
    return JSON.parse(store.getSetting(setting(repo)) ?? "null");
  } catch {
    return null;
  }
};
export const retrospectiveDay = (now: number, timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

export function pendingRetrospective(
  store: Store,
  repo: string,
  now?: number,
  timezone?: string,
): FlightRetrospective | undefined {
  const saved = read(store, repo);
  if (
    now !== undefined &&
    timezone &&
    saved?.day !== retrospectiveDay(now, timezone) &&
    clockHm(now, timezone) >= FLIGHT_RETROSPECTIVE_TIME
  )
    return undefined;
  return saved?.told ? undefined : saved?.report;
}

export function markRetrospectiveShown(store: Store, state: FlightState): void {
  const saved = read(store, state.repo);
  if (saved && saved.day === state.retrospective?.day)
    store.setSetting(setting(state.repo), JSON.stringify({ ...saved, told: true }));
}

const normaliseRoute = (path: string): string =>
  path.split("?")[0]?.replace(/:[^/]+/g, ":param") ?? "";

/** The web's central path table, read as text: repo code is never imported or executed. */
function screenPaths(source: string): Set<string> {
  const paths = new Set<string>();
  const templates = source.replace(/\$\{[^}]+\}/g, ":param");
  for (const match of templates.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
    const path = match[1] ?? "";
    if (path.startsWith(`${API_PREFIX}/`)) paths.add(normaliseRoute(path.slice(API_PREFIX.length)));
  }
  return paths;
}

/** Route handlers named in the web path table or explicitly annotated with a web reader. */
function screenRouteLines(source: string, paths: Set<string>): Set<number> {
  const lines = source.split("\n");
  const result = new Set<number>();
  for (let n = 0; n < lines.length; n++) {
    const route = lines[n] ?? "";
    if (!SCREEN_ROUTE_START.test(route)) continue;
    const match = SCREEN_ROUTE_DECLARATION.exec(lines.slice(n, n + 8).join("\n"));
    if (!match) continue;
    let start = n;
    while (start > 0 && /^\s*\/\//.test(lines[start - 1] ?? "")) start--;
    const annotated = lines.slice(start, n).some((line) => SCREEN_READER_ANNOTATION.test(line));
    if (!annotated && !paths.has(normaliseRoute(match[2] ?? ""))) continue;
    for (let k = start; k <= n; k++) result.add(k + 1);
    if (route.endsWith(");")) continue;
    while (++n < lines.length) {
      const line = lines[n] ?? "";
      result.add(n + 1);
      if (line.startsWith(`${match[1]}});`) || line.startsWith(`${match[1]});`)) break;
    }
  }
  return result;
}

/** One batch reads both revisions, including missing files on additions/deletions. */
async function readObjects(git: ScreenGit, objects: string[]): Promise<(string | null)[]> {
  const output = await git(["--no-lazy-fetch", "cat-file", "--batch"], `${objects.join("\n")}\n`);
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  let offset = 0;
  return objects.map(() => {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete cat-file header");
    const header = bytes.subarray(offset, end).toString();
    offset = end + 1;
    if (header.endsWith(" missing")) return null;
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error("Expected a blob");
    const size = Number(match[1]);
    if (offset + size >= bytes.length || bytes[offset + size] !== 10)
      throw new Error("Incomplete cat-file body");
    const source = bytes.subarray(offset, offset + size).toString();
    offset += size + 1;
    return source;
  });
}

export async function hasScreen(git: ScreenGit, ref: string): Promise<boolean> {
  return (
    (await git(["--no-lazy-fetch", "ls-tree", "-d", "--name-only", ref, "--", SCREEN_WEB_DIR]))
      .toString()
      .trim() === SCREEN_WEB_DIR
  );
}

/** One name-only diff and one batched object read; never textconv or configured diff drivers. */
export async function mergedTouchesScreen(
  git: ScreenGit,
  sha: string | null | undefined,
  applicable?: boolean,
): Promise<boolean | null> {
  if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) return null;
  try {
    if (!(applicable ?? (await hasScreen(git, sha)))) return null;
    const revisions = [`${sha}^1`, sha];
    const paths = (
      await git([
        "--no-lazy-fetch",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "-z",
        ...revisions,
        "--",
      ])
    )
      .toString()
      .split("\0")
      .filter(Boolean);
    if (paths.some((p) => p.startsWith(`${SCREEN_WEB_DIR}/`))) return true;
    const serverPaths = paths.filter((p) => p.startsWith(SCREEN_SERVER_DIR) && p.endsWith(".ts"));
    if (serverPaths.length === 0) return false;
    // Batch input is line-delimited; unusual paths cannot safely be classified here.
    if (serverPaths.some((p) => /[\r\n]/.test(p))) return null;
    const files = [SCREEN_PATH_TABLE, ...serverPaths];
    const sources = await readObjects(
      git,
      revisions.flatMap((ref) => files.map((p) => `${ref}:${p}`)),
    );
    const webPaths = revisions.map((_, side) => screenPaths(sources[side * files.length] ?? ""));
    for (let file = 1; file < files.length; file++) {
      const routes = revisions.map((_, side) => {
        const source = sources[side * files.length + file] ?? "";
        const lines = source.split("\n");
        return [...screenRouteLines(source, webPaths[side] ?? new Set())]
          .map((n) => lines[n - 1])
          .join("\n");
      });
      if (routes[0] !== routes[1]) return true;
    }
    return false;
  } catch {
    return null;
  }
}

export function retrospectiveDue(config: CcConfig, store: Store, now: number): string | null {
  const found = flightSeat(config);
  if (!found || clockHm(now, config.operator.timezone) < FLIGHT_RETROSPECTIVE_TIME) return null;
  const day = retrospectiveDay(now, config.operator.timezone);
  return read(store, found.session.repoId)?.day === day ? null : day;
}

/** Catch up after 03:00, retaining the prepared fact until a wake is successfully delivered. */
export async function prepareRetrospective(
  config: CcConfig,
  store: Store,
  now: number,
): Promise<void> {
  const found = flightSeat(config);
  if (!found) return;
  const { repoId, checkout } = found.session;
  const day = retrospectiveDay(now, config.operator.timezone);
  if (!retrospectiveDue(config, store, now)) return;
  const metrics = flightMetrics(config, store, now);
  const merged = store
    .pullRequests(repoId)
    .filter(
      (p) =>
        p.state === "merged" &&
        p.mergedAt !== null &&
        p.mergedAt >= metrics.since &&
        p.mergedAt <= now,
    );
  const common = join(checkout, ".git");
  const git: ScreenGit = (args, input) =>
    input === undefined
      ? crewGit(checkout, args, common, { gitDir: common })
      : crewGitBytes(checkout, args, common, { gitDir: common, input });
  let applicable = false;
  if (merged.length > 0) {
    try {
      const heads = originHeads(
        await crewGit(checkout, ["ls-remote", "--symref", "origin", "HEAD"], common, {
          gitDir: common,
          timeoutMs: CREW_GIT_SLOW_MS,
        }),
        null,
      );
      await crewGit(
        checkout,
        ["fetch", "--no-tags", "origin", `refs/heads/${heads.defaultBranch}`],
        common,
        { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS },
      );
      applicable = await hasScreen(git, heads.defaultSha);
    } catch {
      // A failed refresh still permits classification from available local commits.
      applicable = await hasScreen(git, "HEAD").catch(() => false);
    }
  }
  let touching = 0;
  let unknown = Math.max(0, merged.length - FLIGHT_RETROSPECTIVE_PRS_MAX);
  for (const pr of merged.slice(0, FLIGHT_RETROSPECTIVE_PRS_MAX)) {
    const touches = await mergedTouchesScreen(git, pr.mergeCommitSha, applicable);
    if (touches === null) unknown++;
    else if (touches) touching++;
  }
  const reviews = store.reviewsIn(["reported"], { repo: repoId, since: metrics.since, until: now });
  const failed = reviews.filter(
    (r) => r.blocking > 0 || r.verdict?.spec === "fail" || r.verdict?.quality === "fail",
  ).length;
  const parks = new Map<string, number>();
  const prefix = parkedEventText("");
  for (const event of store.loopEvents(metrics.since, repoId)) {
    if (event.at > now || !event.text.startsWith(prefix)) continue;
    const reason = cut(
      event.text.slice(prefix.length).replace(/\b[0-9a-f]{7,40}\b/g, "<sha>"),
      FLIGHT_RETROSPECTIVE_REASON_MAX,
    );
    parks.set(reason, (parks.get(reason) ?? 0) + 1);
  }
  const report: FlightRetrospective = {
    day,
    at: now,
    metrics,
    screenChanges: {
      touching,
      unknown,
      share: merged.length === unknown ? null : touching / (merged.length - unknown),
    },
    reviews: {
      reported: reviews.length,
      failed,
      failRate: reviews.length === 0 ? null : failed / reviews.length,
    },
    parkReasons: [...parks]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason))
      .slice(0, FLIGHT_RETROSPECTIVE_PARKS_MAX),
    redMain: flightSignalHistory(store, repoId, now).filter(
      (s) => s.kind === "main_red" && s.lastSeen >= metrics.since && s.lastSeen <= now,
    ),
    costlyRuns: store
      .runsActiveSince(metrics.since)
      .filter((r) => r.repoId === repoId && r.startedAt <= now)
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || a.id.localeCompare(b.id))
      .slice(0, FLIGHT_COSTLY_RUNS_MAX)
      .map((r) => ({ runId: r.id, seat: r.agentId, ticket: r.ticket, costUsd: r.costUsd })),
    productPass: { pages: HUD_PRODUCT_PAGES, instruction: PRODUCT_PASS_INSTRUCTION },
  };
  store.setSetting(
    setting(repoId),
    JSON.stringify({ day, told: false, report } satisfies RetrospectiveRecord),
  );
  store.recordRetrospective(repoId, day, now, report);
}
