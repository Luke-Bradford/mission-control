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

export function answer(path: string): Response {
  const api = getState().api;
  const key = path in ALIASES ? (ALIASES[path] as string) : path;
  if (key in api) return json(api[key]);
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
