import {
  type ActivityRow,
  type AttentionItem,
  COMMS_CAPCOM,
  COMMS_MC,
  type CrewRow,
} from "@mc/core";
import { useEffect, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { COMMS_SEEN_KEY, readKey, writeKey } from "../storage.ts";
import { agentComms, CAPCOM_TAG, commsKeys } from "./messages.tsx";

interface Seen {
  at: number;
  keys: string[];
}

function readSeen(): Record<string, Seen> {
  try {
    const value: unknown = JSON.parse(readKey(COMMS_SEEN_KEY) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const seen: Record<string, Seen> = {};
    for (const [id, cursor] of Object.entries(value)) {
      // Old timestamp-only cursors conservatively leave equal-time messages unread.
      if (typeof cursor === "number" && Number.isFinite(cursor)) {
        seen[id] = { at: cursor, keys: [] };
      } else if (
        cursor &&
        typeof cursor.at === "number" &&
        Number.isFinite(cursor.at) &&
        Array.isArray(cursor.keys) &&
        cursor.keys.every((key: unknown) => typeof key === "string")
      ) {
        seen[id] = { at: cursor.at, keys: cursor.keys };
      }
    }
    return seen;
  } catch {
    return {};
  }
}

function unseen(cursor: Seen | undefined, at: number, key: string): boolean {
  return !cursor || at > cursor.at || (at === cursor.at && !cursor.keys.includes(key));
}

/** Unseen messages belong to the sending agent's thread, even when it tagged you in a peer message. */
export function useThreadAttention(
  items: AttentionItem[] | undefined,
  rows: CrewRow[],
  selected: string | undefined,
): AttentionItem[] | undefined {
  const activity = useResource<ActivityRow[]>(RESOURCES.activity).data;
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    if (selected === undefined) return;
    const messages = agentComms(activity ?? [], selected);
    const messageKeys = commsKeys(messages);
    const channelItems = (items ?? []).filter((i) => i.agentId === selected && isChannelItem(i));
    const previous = seen[selected];
    const at = Math.max(
      previous?.at ?? Number.NEGATIVE_INFINITY,
      ...messages.map((m) => m.at),
      ...channelItems.map((i) => i.at),
    );
    if (!Number.isFinite(at)) return;
    const keys = [
      ...new Set([
        ...(previous?.at === at ? previous.keys : []),
        ...messageKeys.filter((_, index) => messages[index]?.at === at),
        ...channelItems.filter((i) => i.at === at).map((i) => i.key),
      ]),
    ];
    if (previous?.at === at && keys.length === previous.keys.length) return;
    const next = { ...seen, [selected]: { at, keys } };
    setSeen(next);
    writeKey(COMMS_SEEN_KEY, JSON.stringify(next));
  }, [activity, items, selected, seen]);

  if (items === undefined) return undefined;
  const list = items.filter(
    (i) =>
      !isChannelItem(i) ||
      i.agentId === null ||
      (i.agentId !== selected && unseen(seen[i.agentId], i.at, i.key)),
  );
  for (const row of rows) {
    if (row.id === selected) continue;
    const messages = agentComms(activity ?? [], row.id);
    const keys = commsKeys(messages);
    const unread = messages.filter(
      (m, index) =>
        m.who === row.id &&
        m.who !== COMMS_CAPCOM &&
        m.who !== COMMS_MC &&
        unseen(seen[row.id], m.at, keys[index] ?? ""),
    );
    const tag = unread.filter((m) => m.text.includes(CAPCOM_TAG)).at(-1);
    const replies = unread.filter((m) => m.to === COMMS_CAPCOM);
    const add = (kind: "tag" | "message", text: string, at: number) => {
      if (list.some((i) => i.agentId === row.id && i.kind === kind)) return;
      list.push({
        key: `${kind}:${row.id}:${at}`,
        kind,
        agentId: row.id,
        repoId: row.repoId,
        text,
        at,
        tool: null,
        url: null,
        escalationId: null,
        ticket: null,
        acked: false,
      });
    };
    if (tag) add("tag", tag.text, tag.at);
    const last = replies.at(-1);
    if (last) add("message", `${replies.length} new on your direct line`, last.at);
  }
  return list;
}

export const isChannelItem = (i: AttentionItem): boolean =>
  i.kind === "tag" || i.kind === "message";
