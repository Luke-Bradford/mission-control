import type { AttentionHold, AttentionHoldCondition, AttentionItem } from "@mc/core";
import {
  type BriefOption,
  COMMS_OPEN_PREFIX,
  flightFloorBlocked,
  GUARD_ACK_PREFIX,
} from "@mc/core";
import { z } from "zod";
import { runAccountId } from "./account-bindings.ts";
import type { CcConfig } from "./config.ts";
import { accountAtStop } from "./engine/queue.ts";
import { NOTE_KEY } from "./hud.ts";
import type { Store } from "./store.ts";
import { HUB_UPDATE_HELD_KEY } from "./update.ts";

const SETTING = "attention-holds";
export function holds(store: Store): Record<string, AttentionHold> {
  // null prototype, so a key such as `__proto__` is an ordinary entry
  return Object.assign(Object.create(null), JSON.parse(store.getSetting(SETTING) ?? "{}"));
}
export function holdItem(
  store: Store,
  key: string,
  reason: string,
  condition: AttentionHoldCondition,
  by: string,
  at: number,
): void {
  const all = holds(store);
  all[key] = { reason, condition, by, at };
  store.setSetting(SETTING, JSON.stringify(all));
}
export function releaseHold(store: Store, key: string, at: number): boolean {
  const all = holds(store);
  const hold = all[key];
  if (!hold || hold.releasedAt !== undefined) return false;
  hold.releasedAt = at;
  store.setSetting(SETTING, JSON.stringify(all));
  return true;
}
export function conditionText(c: AttentionHoldCondition): string {
  switch (c.kind) {
    case "date":
      return new Date(c.at).toISOString();
    case "ticket":
      return `until ${c.ticket} merges`;
    case "crew":
      return "until the crew resumes";
    case "manual":
      return "until I release it";
  }
}
export function evaluateHolds(
  store: Store,
  at: number,
  merged: (ticket: string) => boolean,
  resumed: (since: number) => boolean,
): boolean {
  let changed = false;
  for (const [key, hold] of Object.entries(holds(store))) {
    if (hold.releasedAt !== undefined) continue;
    const c = hold.condition;
    if (
      (c.kind === "date" && at >= c.at) ||
      (c.kind === "ticket" && merged(c.ticket)) ||
      (c.kind === "crew" && resumed(hold.at))
    ) {
      changed = releaseHold(store, key, at) || changed;
    }
  }
  return changed;
}
export function partitionAttention(
  store: Store,
  items: AttentionItem[],
  acks = store.acks(),
): { items: AttentionItem[]; held: AttentionItem[] } {
  const all = holds(store);
  const active: AttentionItem[] = [];
  const held: AttentionItem[] = [];
  for (const item of items) {
    const hold = all[item.key];
    if (hold && hold.at >= item.at && hold.releasedAt === undefined) held.push({ ...item, hold });
    else
      active.push(
        hold?.releasedAt !== undefined && hold.at >= item.at
          ? {
              ...item,
              owner: "operator",
              acked: (acks.get(item.key) ?? 0) >= hold.releasedAt,
              holdReleased: conditionText(hold.condition),
            }
          : item,
      );
  }
  return { items: active, held };
}

export const AttentionHoldInput = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    condition: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }).strict(),
      z.object({ kind: z.literal("crew") }).strict(),
      z
        .object({
          kind: z.literal("date"),
          at: z.number().int().min(0).max(8640000000000000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ticket"),
          ticket: z.string().regex(/^[^#\s]+#[1-9]\d*$/),
        })
        .strict(),
    ]),
  })
  .strict();

export function attentionHoldError(e: z.ZodError): string {
  const issue = e.issues[0];
  if (!issue) return "invalid body";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** Items whose authority belongs to the operator and which a timer must never settle. */
export function heldRun(
  store: Store,
  config: CcConfig,
  at: number,
  run: NonNullable<ReturnType<Store["run"]>>,
  repoId?: string,
): boolean {
  const seat = config.crew?.sessions.flatMap((s) => s.seats).find((s) => s.id === run.agentId);
  return (
    !seat ||
    (repoId !== undefined && run.repoId !== repoId) ||
    store.seatSession(run.agentId)?.state === "stopped" ||
    run.loop?.parked?.kind === "budget" ||
    store
      .openQuestions()
      .some((q) => q.runId === run.id && (q.passedAt !== null || at - q.at >= 20 * 60_000)) ||
    accountAtStop(config, store, runAccountId(store, run.id, seat.accountId), at)
  );
}

export function protectedDecisionItem(
  store: Store,
  item: AttentionItem,
  config?: CcConfig,
  at?: number,
): boolean {
  if (item.key.startsWith("esc:")) return true;
  if (item.kind === "approval" || item.kind === "flag" || item.kind === "ratelimit") return true;
  if (item.key === `${NOTE_KEY}${HUB_UPDATE_HELD_KEY}`) return true;
  if (item.key.startsWith(`${NOTE_KEY}${GUARD_ACK_PREFIX}`)) return true;
  const note = store.notes().find((n) => `${NOTE_KEY}${n.key}` === item.key);
  // A Comms question or blocker has no note: it is held when its sender's run is.
  const commsOpen = item.key.startsWith(COMMS_OPEN_PREFIX);
  const run = commsOpen
    ? item.agentId === null
      ? null
      : (store.seatRun(item.agentId) ?? null)
    : note?.runId
      ? store.run(note.runId)
      : null;
  if (
    run &&
    config !== undefined &&
    at !== undefined &&
    heldRun(store, config, at, run, item.repoId ?? undefined)
  )
    return true;
  if (item.kind === "decision" && run?.loop && flightFloorBlocked(run.loop)) return true;
  const pr = /^pr:([^#]+)#(\d+):/.exec(item.key);
  if (
    item.kind === "pr" &&
    pr !== null &&
    store
      .loopRuns(0)
      .some(
        (r) =>
          r.repoId === pr[1] && r.loop?.prNumber === Number(pr[2]) && flightFloorBlocked(r.loop),
      )
  )
    return true;
  if (item.kind !== "blocked" || commsOpen) return false;
  const parked = run?.loop?.parked?.kind;
  // A blocked row is an operator hold unless it can be proved to be an ordinary, non-parked
  // note. Missing source rows are deliberately treated as protected rather than defaulted.
  return note === undefined || note.runId === null || parked === "budget" || parked === "account";
}

/** A recommended reversible decision and the stored point at which it may apply. */
export function decisionDefault(
  store: Store,
  item: AttentionItem,
  config?: CcConfig,
  at?: number,
): { option: BriefOption; briefAt: number; dueAt: number } | null {
  const brief = item.brief;
  if (
    item.owner !== "operator" ||
    !brief ||
    brief.for === "flight" ||
    brief.defaultAt === undefined ||
    protectedDecisionItem(store, item, config, at)
  )
    return null;
  const option = brief.options.find(
    (o) => o.id !== undefined && o.id === brief.recommendedOptionId,
  );
  if (!option) return null;
  const briefAt = brief.askAt ?? brief.at;
  const hold = holds(store)[item.key];
  const released = hold?.releasedAt !== undefined && hold.at >= item.at ? hold.releasedAt : 0;
  return {
    option,
    briefAt,
    dueAt: Math.max(brief.defaultAt, released + (brief.defaultAt - briefAt)),
  };
}
