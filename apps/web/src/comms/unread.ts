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
import { agentComms, CAPCOM_TAG } from "./messages.tsx";

function readSeen(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(readKey(COMMS_SEEN_KEY) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, at]) => typeof at === "number" && Number.isFinite(at)),
    );
  } catch {
    return {};
  }
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
    const at = Math.max(
      ...agentComms(activity ?? [], selected).map((m) => m.at),
      ...(items ?? []).filter((i) => i.agentId === selected && isChannelItem(i)).map((i) => i.at),
    );
    if (at <= (seen[selected] ?? Number.NEGATIVE_INFINITY)) return;
    const next = { ...seen, [selected]: at };
    setSeen(next);
    writeKey(COMMS_SEEN_KEY, JSON.stringify(next));
  }, [activity, items, selected, seen]);

  if (items === undefined) return undefined;
  const list = items.filter(
    (i) =>
      !isChannelItem(i) ||
      i.agentId === null ||
      (i.agentId !== selected && i.at > (seen[i.agentId] ?? Number.NEGATIVE_INFINITY)),
  );
  for (const row of rows) {
    if (row.id === selected) continue;
    const unread = agentComms(activity ?? [], row.id).filter(
      (m) =>
        m.who === row.id &&
        m.who !== COMMS_CAPCOM &&
        m.who !== COMMS_MC &&
        m.at > (seen[row.id] ?? Number.NEGATIVE_INFINITY),
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
