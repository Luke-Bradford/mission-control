/**
 * The Demo "server": answers a read by its path from the simulator's state. This is its own chunk,
 * loaded the first time Demo reads. Nothing here touches the network.
 */
import { ACTIVITY_WINDOW_MS } from "@mc/core";
import { commsMessage } from "../../test/demoSeedPages.ts";
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

const MIN_MS = 60_000;
const OPENED_AT = Date.now();

/** Two unanswered questions, one fresh and one long: so waiting is something Demo can show. */
function openItems(): unknown {
  const waited = Date.now() - OPENED_AT;
  return {
    items: [
      {
        id: "demo-open-1",
        label: "question",
        from: "dev-4",
        to: "flight-1",
        ticket: "shop-app#104",
        waitedMs: 14 * MIN_MS + waited,
        nextStep: "flight",
        nextAt: Date.now() + 10 * MIN_MS,
        question: "Should the address form keep the postcode lookup on narrow screens?",
        text: "Should the address form keep the postcode lookup on narrow screens?",
      },
      {
        id: "demo-open-2",
        label: "blocker",
        from: "dev-7",
        to: "CAPCOM",
        ticket: "shop-app#107",
        waitedMs: 190 * MIN_MS + waited,
        nextStep: "flight-not-triaging",
        nextAt: Date.now() + 30 * MIN_MS,
        question: "The CSV export needs a decision on the date format.",
        text: "The CSV export needs a decision on the date format.",
      },
    ],
  };
}

/** The last day's messages one by one: each link's recent pair, then the crew channel's. */
function feed(): unknown {
  const links = (getState().api["/api/comms/links"] as { links: { from: string; to: string }[] })
    .links;
  const crew = getState().api["/api/comms/crew"] as {
    messages: { id: string; from: string; to: string; at: number; text: string }[];
  };
  const now = Date.now();
  const direct = links.flatMap((link, i) =>
    [0, 1].map((k) => ({
      id: `demo-feed:${i}-${k}`,
      from: link.from,
      to: link.to,
      at: now - (i * 7 + k * 13 + 1) * MIN_MS,
      text: commsMessage(i + k, now).text,
    })),
  );
  const channel = crew.messages.map((m) => ({
    id: m.id,
    from: m.from,
    to: m.to,
    at: m.at,
    text: m.text,
  }));
  return { messages: [...direct, ...channel].sort((a, b) => b.at - a.at) };
}

/** The QA history, narrowed to one repository when the read names one. */
function history(path: string): unknown {
  const m = /^\/api\/qa\/history\?(.*)$/.exec(path);
  if (!m) return undefined;
  const page = getState().api["/api/qa/history?limit=50"] as { entries: { repoId: string }[] };
  const repo = new URLSearchParams(m[1]).get("repoId");
  return repo ? { ...page, entries: page.entries.filter((e) => e.repoId === repo) } : page;
}

/** One listed file's diff: a few changed lines. */
function fileDiff(path: string): unknown {
  const m = /^\/api\/agents\/[^/]+\/files\/diff\?path=(.+)$/.exec(path);
  if (!m) return undefined;
  const file = decodeURIComponent(m[1] ?? "");
  return {
    path: file,
    text: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,4 @@\n const total = quote.total;\n-return total;\n+const cached = cache.get(total);\n+return cached ?? total;\n`,
    truncated: false,
    binary: false,
    sha: null,
  };
}

export function answer(path: string): Response {
  const api = getState().api;
  const key = path in ALIASES ? (ALIASES[path] as string) : path;
  if (key in api) return json(api[key]);
  const diff = fileDiff(path);
  if (diff !== undefined) return json(diff);
  if (path === "/api/comms/traffic") return json(traffic());
  if (path === "/api/comms/open") return json(openItems());
  if (path === "/api/comms/feed") return json(feed());
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
