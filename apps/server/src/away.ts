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

export function readAwaySettings(store: Store): AwaySettings {
  const raw = store.getSetting(AWAY_SETTING);
  try {
    const parsed = AwayBody.safeParse(JSON.parse(raw ?? "null"));
    return parsed.success ? parsed.data : DEFAULT_AWAY;
  } catch {
    return DEFAULT_AWAY;
  }
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
): AwayDigest {
  const prs = repos
    .flatMap((repo) => store.pullRequests(repo))
    .filter((p) => p.state === "open")
    .sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  return {
    active,
    groups: [
      { kind: "needYouNow", items: attention.filter((i) => i.owner === OWNER_OPERATOR) },
      { kind: "safePrsReady", items: prs.filter((p) => !p.isDraft && p.ci === "passing") },
      { kind: "draftsToWalkThrough", items: prs.filter((p) => p.isDraft) },
      {
        kind: "failures",
        items: store
          .runsActiveSince(0)
          .flatMap((r) =>
            r.loop?.parked ? [{ runId: r.id, ticket: r.ticket, reason: r.loop.parked.reason }] : [],
          ),
      },
      { kind: "flightDecisions", items: store.flightDecisions(0, -1) },
      { kind: "messagesDrafted", items: store.drafts() },
    ],
  };
}
