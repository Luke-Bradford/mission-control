import {
  type AttentionItem,
  AWAY_SETTING,
  type AwayDigest,
  type AwaySettings,
  awayIsOn,
  DEFAULT_AWAY,
  OWNER_OPERATOR,
} from "@mc/core";
import { z } from "zod";
import type { Store } from "./store.ts";

/** `YYYY-MM-DD` naming a real calendar day. */
const isCalendarDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
};

/** A full AwaySettings: `until` is empty (until turned off) or a real `YYYY-MM-DD`. */
export const AwayBody = z.strictObject({
  on: z.boolean(),
  until: z.string().refine((s) => s === "" || isCalendarDate(s), {
    message: "must be empty or a calendar date YYYY-MM-DD",
  }),
  may: z.strictObject({
    pickUp: z.boolean(),
    research: z.boolean(),
    check: z.boolean(),
    status: z.boolean(),
    safePr: z.boolean(),
  }),
}) satisfies z.ZodType<AwaySettings>;

export const AWAY_STARTED_SETTING = "awayStartedAt";
export const AWAY_DIGEST_DECISIONS_MAX = 200;
export const AWAY_DIGEST_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const AWAY_CORRUPT_LOG =
  "Invalid away settings: holding away mode on with all permissions off.";
export const CLOSED_AWAY: AwaySettings = {
  on: true,
  until: "",
  may: { pickUp: false, research: false, check: false, status: false, safePr: false },
};
const warnedStores = new WeakSet<Store>();

export function readAwaySettings(store: Store): AwaySettings {
  const raw = store.getSetting(AWAY_SETTING);
  if (raw === null) return DEFAULT_AWAY;
  try {
    const parsed = AwayBody.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* A corrupt row must not enable writes. */
  }
  if (!warnedStores.has(store)) {
    warnedStores.add(store);
    console.warn(AWAY_CORRUPT_LOG);
  }
  return CLOSED_AWAY;
}

export function activeAway(store: Store, now: number, timezone: string): AwaySettings | null {
  const settings = readAwaySettings(store);
  return awayIsOn(settings, now, timezone) ? settings : null;
}

/** Current outstanding work and the existing decision history; no digest or visit marker is saved. */
export function awayDigest(
  store: Store,
  active: boolean,
  attention: AttentionItem[],
  repos: string[],
  at: number = Date.now(),
  since?: number,
): AwayDigest {
  const started = Number(store.getSetting(AWAY_STARTED_SETTING));
  const after = since ?? (started > 0 ? started : at - AWAY_DIGEST_LOOKBACK_MS);
  const runs = store.runsForAwayDigest();
  const prs = repos
    .flatMap((repo) => store.pullRequests(repo))
    .filter((p) => p.state === "open")
    .sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  return {
    active,
    groups: [
      {
        kind: "needYouNow",
        items: attention.filter(
          (i) =>
            !i.acked &&
            (i.owner === undefined || i.owner === OWNER_OPERATOR || i.flightTriage !== undefined),
        ),
      },
      {
        kind: "safePrsReady",
        items: prs.filter(
          (p) =>
            !p.isDraft &&
            p.ci === "passing" &&
            runs.some(
              (r) =>
                r.repoId === p.repoId &&
                r.loop?.prNumber === p.number &&
                r.loop.merging?.done.includes("ready") &&
                r.loop.merging.sha === p.headSha,
            ),
        ),
      },
      { kind: "draftsToWalkThrough", items: prs.filter((p) => p.isDraft) },
      {
        kind: "failures",
        items: runs.flatMap((r) =>
          r.endedAt === null && r.loop?.parked && !r.loop.parked.ended
            ? [{ runId: r.id, ticket: r.ticket, reason: r.loop.parked.reason }]
            : [],
        ),
      },
      { kind: "flightDecisions", items: store.flightDecisions(after, AWAY_DIGEST_DECISIONS_MAX) },
      { kind: "messagesDrafted", items: store.drafts() },
    ],
  };
}
