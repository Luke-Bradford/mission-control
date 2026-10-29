import {
  type AttentionHold,
  type AttentionHoldCondition,
  type AttentionItem,
  type BriefOption,
  DECISION_DEFAULT_WAIT_MS,
} from "@mc/core";
import { z } from "zod";
import type { Store } from "./store.ts";

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

/**
 * A decision's default: its recommended option and when it applies if nobody has answered. The
 * wait runs from the ask, and from the hold's release when the operator held it meanwhile (a hold
 * stops the clock). Null for anything that is not an operator decision with a recommendation (an escalation is answered on GitHub, which the hub does not write to).
 */
export function decisionDefault(
  store: Store,
  item: AttentionItem,
): { option: BriefOption; briefAt: number; dueAt: number } | null {
  const brief = item.brief;
  if (item.owner !== "operator" || !brief || brief.for === "flight") return null;
  const option = brief.options.find(
    (o) => o.id !== undefined && o.id === brief.recommendedOptionId,
  );
  if (!option) return null;
  if (item.escalationId !== null) return null;
  const briefAt = brief.askAt ?? brief.at;
  const hold = holds(store)[item.key];
  const released = hold?.releasedAt !== undefined && hold.at >= item.at ? hold.releasedAt : 0;
  // the stored deadline; a brief from before it was stored gets the current wait from the ask
  const dueAt = brief.defaultAt ?? briefAt + DECISION_DEFAULT_WAIT_MS;
  return { option, briefAt, dueAt: Math.max(dueAt, released + (dueAt - briefAt)) };
}
