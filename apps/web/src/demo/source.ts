/**
 * The Demo "server": answers a read by its path from the simulator's state. This is its own chunk,
 * loaded the first time Demo reads. Nothing here touches the network.
 */
import { ACTIVITY_WINDOW_MS } from "@mc/core";
import { DEMO_NO_DATA } from "./mode.ts";
import { getState } from "./simulator.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Paths the hub answers 404 to on purpose (a PR with no evidence); not a gap in the seed. */
const INTENDED_404: readonly RegExp[] = [/^\/api\/prs\/\d+\/evidence/];

/** Paths asked of Demo that it has no data for, newest last (tests read it). */
const misses: string[] = [];
export const demoMisses = (): readonly string[] => misses;

/** Paths that answer another path's data (the same object, asked another way). */
const ALIASES: Record<string, string> = {
  "/api/overview?session=demo": "/api/overview",
  "/api/metrics?session=demo": "/api/metrics",
};

function activitySince(path: string): unknown {
  const m = /^\/api\/activity\?since=(\d+)$/.exec(path);
  if (!m) return undefined;
  const since = Number(m[1]);
  const rows = getState().api["/api/activity"] as { at: number }[];
  return rows.filter((r) => r.at >= since && r.at >= Date.now() - ACTIVITY_WINDOW_MS);
}

/** A telemetry read narrowed by seat, account or ticket answers with the range's own data. */
function telemetryRange(path: string): string | undefined {
  const m = /^\/api\/telemetry\?range=([^&]+)&/.exec(path);
  return m ? `/api/telemetry?range=${m[1]}` : undefined;
}

/** A thread between two seats, from what the crew has said to each other. */
function contactThread(path: string): unknown {
  const m = /^\/api\/comms\/agents\/([^/?]+)\/contacts\/([^/?]+)$/.exec(path);
  if (!m) return undefined;
  const [, a, b] = m.map((x) => decodeURIComponent(x ?? ""));
  const crew = getState().api["/api/comms/crew"] as { messages: { from: string }[] };
  return {
    messages: crew.messages.filter((x) => x.from === a || x.from === b).slice(-12),
    hasEarlier: false,
    unread: 0,
  };
}

const HOUR_MS = 3_600_000;

/** Messages per hour over the last 24, between the pairs the links name. Built from the clock. */
function traffic(): unknown {
  const links = (
    getState().api["/api/comms/links"] as { links: { from: string; to: string; count: number }[] }
  ).links;
  const start = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const hours = Array.from({ length: 24 }, (_, h) =>
    links.map((link, i) => ({
      from: link.from,
      to: link.to,
      hour: start + h * HOUR_MS,
      // Busier towards the present, and the newest hour follows the running count.
      count:
        h === 23
          ? Math.ceil(link.count / 4)
          : Math.max(0, 1 + ((h * 5 + i * 3) % 4) - (h < 8 ? 1 : 0)),
    })),
  ).flat();
  return { hours: hours.filter((entry) => entry.count > 0) };
}

/** The QA history, narrowed to one repository when the read names one. */
function history(path: string): unknown {
  const m = /^\/api\/qa\/history\?(.*)$/.exec(path);
  if (!m) return undefined;
  const page = getState().api["/api/qa/history?limit=50"] as { entries: { repoId: string }[] };
  const repo = new URLSearchParams(m[1]).get("repoId");
  return repo ? { ...page, entries: page.entries.filter((e) => e.repoId === repo) } : page;
}

export function answer(path: string): Response {
  const api = getState().api;
  const key = path in ALIASES ? (ALIASES[path] as string) : path;
  if (key in api) return json(api[key]);
  if (path === "/api/comms/traffic") return json(traffic());
  const filtered = history(path);
  if (filtered !== undefined) return json(filtered);
  const range = telemetryRange(path);
  if (range !== undefined && range in api) return json(api[range]);
  const thread = contactThread(path);
  if (thread !== undefined) return json(thread);
  const delta = activitySince(path);
  if (delta !== undefined) return json(delta);
  if (/^\/api\/runs\/[^/]+\/handoff$/.test(path)) return json(null);
  if (/^\/api\/runs\/([^/]+)\/loop$/.test(path))
    return json({ runId: path.split("/")[3], loop: null, events: [], tries: [] });
  if (/^\/api\/agents\/[^/]+\/runs\?/.test(path)) return json([]);
  // An older page of a list is empty: Demo has no history behind what it shows.
  if (/[?&]before=/.test(path))
    return json({ messages: [], events: [], more: false, nextBefore: null });
  if (INTENDED_404.some((re) => re.test(path))) return json({ error: "not found" }, 404);
  misses.push(path);
  return json({ error: DEMO_NO_DATA }, 404);
}
