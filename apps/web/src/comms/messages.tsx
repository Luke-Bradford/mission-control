import {
  type ActivityRow,
  COMMS_CAPCOM,
  COMMS_MC,
  type CommsEvent,
  type ConfigView,
  type Crew,
  seatCallSign,
} from "@mc/core";
import { Fragment } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { AgentTag } from "../hud/AgentTag.tsx";

/** The mention the mockup picks out in a message. */
export const CAPCOM_TAG = "@CAPCOM";

export const isComms = (r: ActivityRow): r is CommsEvent => r.kind === "comms";

/** What an end of a message is called: the operator, the engine, or a seat's call sign. */
export function commsName(id: string): string {
  if (id === COMMS_CAPCOM) return "You";
  if (id === COMMS_MC) return "Mission Control";
  return seatCallSign(id);
}

/** What `id` sent or received (since `since`), oldest first. */
export function agentComms(rows: ActivityRow[], id: string, since = Number.NEGATIVE_INFINITY) {
  return rows
    .filter((r): r is CommsEvent => isComms(r) && (r.who === id || r.to === id) && r.at >= since)
    .sort((a, b) => a.at - b.at);
}

/** A message as `id` sees it: `→ CALL: text` when sent, `← CALL: text` when received. */
export function commsLine(c: CommsEvent, id: string): string {
  return c.who === id ? `→ ${commsName(c.to)}: ${c.text}` : `← ${commsName(c.who)}: ${c.text}`;
}

/** Messages have no id: key by content, and number repeats so twins never share a key. */
export function commsKeys(list: CommsEvent[]): string[] {
  const seen = new Map<string, number>();
  return list.map((c) => {
    const base = `comms:${JSON.stringify([c.at, c.who, c.to, c.text])}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

/** Plain text with each mention picked out. */
export function MentionText({ text }: { text: string }) {
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const login = (config as (ConfigView & { githubLogin?: string | null }) | undefined)?.githubLogin;
  const parts = text.split(/((?<![\w.])@[\w-]+)/);
  return (
    <>
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional and never reorder
        <Fragment key={i}>
          {i % 2 === 1 &&
          (part.toLowerCase() === CAPCOM_TAG.toLowerCase() ||
            (login && part.toLowerCase() === `@${login.toLowerCase()}`)) ? (
            <span className="mention">{part}</span>
          ) : (
            part
          )}
        </Fragment>
      ))}
    </>
  );
}

/** One end of a message: a configured agent's tag, the operator, the engine, or any other id muted. */
export function CommsEnd({ id }: { id: string }) {
  const row = useResource<Crew>(RESOURCES.crew).data?.rows.find((r) => r.id === id);
  if (row) return <AgentTag id={row.id} index={row.index} sm />;
  if (id === COMMS_CAPCOM || id === COMMS_MC) return <b>{commsName(id)}</b>;
  return <span className="muted">{id}</span>;
}
