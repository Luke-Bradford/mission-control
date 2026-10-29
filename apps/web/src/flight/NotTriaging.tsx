import {
  ATTENTION_LABEL,
  type AttentionItem,
  FLIGHT_TRIAGE_LABEL,
  type FlightView,
} from "@mc/core";
import { useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { needsLamp } from "../crew.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { Lamp } from "../hud/Lamp.tsx";
import { openItem } from "../shell/overlays.ts";

/** The one "FLIGHT is not triaging" item (#758): the server sets `notTriaging` on it alone. */
export const isNotTriaging = (i: AttentionItem): boolean => i.notTriaging !== undefined;

/** The items it counts, as the attention list holds them, oldest first. */
export function notTriagingItems(
  item: AttentionItem,
  items: readonly AttentionItem[] | undefined,
): AttentionItem[] {
  const keys = item.notTriaging?.keys ?? [];
  const byKey = new Map((items ?? []).map((i) => [i.key, i]));
  return keys.flatMap((k) => {
    const i = byKey.get(k);
    return i ? [i] : [];
  });
}

/**
 * The "FLIGHT is not triaging: N waiting since T" row: Start FLIGHT while it is not live, and Show
 * them, which lists the items it stands for under it (they stay FLIGHT's, so Needs you counts
 * this one item instead). `open` starts it shown, as on Needs you's home.
 */
export function NotTriagingRow({
  item,
  items,
  open = false,
  onAck,
  busy = false,
}: {
  item: AttentionItem;
  items: readonly AttentionItem[] | undefined;
  open?: boolean;
  onAck?: () => void;
  busy?: boolean;
}) {
  const seat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const [shown, setShown] = useState(open);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = notTriagingItems(item, items);
  const lamp = needsLamp([item], !item.acked);
  const start = async () => {
    if (!seat) return;
    setStarting(true);
    setError(null);
    try {
      await apiPost(ACTIONS.seatStart(seat.id), {});
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(errorNote(err) ?? err.message);
    } finally {
      setStarting(false);
    }
  };
  return (
    <div
      className={item.acked ? "nrow acked" : "nrow"}
      data-kind={item.kind}
      data-testid="not-triaging"
    >
      {lamp && <Lamp {...lamp} />}
      <div className="min0">
        <span className="kind">FLIGHT</span> <MarkdownInline text={item.text} />
        {error && <div className="xs crit-t">{error}</div>}
        {shown && waiting.length > 0 && (
          <ul className="not-triaging-list" aria-label="Waiting on FLIGHT">
            {waiting.map((i) => (
              <li key={i.key} className="s">
                <span className="kind">{ATTENTION_LABEL[i.kind]}</span>{" "}
                <span className="xs muted">
                  {i.flightTriage === undefined ? "" : FLIGHT_TRIAGE_LABEL[i.flightTriage]}
                </span>{" "}
                <MarkdownInline text={i.text} max={170} />{" "}
                <button type="button" className="sm ghost" onClick={() => openItem(i.key)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="acts">
        {seat && !seat.live && (
          <button
            type="button"
            className="sm primary"
            disabled={starting}
            onClick={() => void start()}
          >
            Start FLIGHT
          </button>
        )}
        {waiting.length > 0 && (
          <button
            type="button"
            className="sm"
            aria-expanded={shown}
            onClick={() => setShown((s) => !s)}
          >
            {shown ? "Hide them" : "Show them"}
          </button>
        )}
        {onAck && !item.acked && (
          <button type="button" className="sm ghost" disabled={busy} onClick={onAck}>
            Ack
          </button>
        )}
      </div>
    </div>
  );
}
