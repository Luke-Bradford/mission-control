import type { AttentionItem, CrewRow } from "@mc/core";
import { useState } from "react";
import { ackKeys } from "../ack.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { NeedButton } from "../components/NeedButton.tsx";
import { needLine, seatItems } from "../crew.ts";

/**
 * When the agent has needs (catalogue 2.4.2): `{id} needs you.`, the Overview's need line, and Ack
 * for its unacknowledged items (shown only while there are any).
 */
export function NeedBanner({
  row,
  items,
  now,
}: {
  row: CrewRow;
  items: AttentionItem[];
  now: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parts = needLine(row, items, now, useTestLock());
  const unacked = seatItems(row, items)
    .filter((i) => !i.acked)
    .map((i) => i.key);

  const ack = async () => {
    setBusy(true);
    setError(null);
    setError(await ackKeys(unacked));
    setBusy(false);
  };

  return (
    <div id="needBanner">
      {parts.length > 0 && (
        <div className="banner">
          <b>{row.id} needs you.</b>
          {parts.map((p, i) => (
            <span key={p.key} className="needpart">
              {i > 0 && <span aria-hidden="true">· </span>}
              <span>
                <MarkdownInline text={p.text} />
              </span>
              <NeedButton part={p} row={row} />
            </span>
          ))}
          {unacked.length > 0 && (
            <button type="button" className="sm ghost" disabled={busy} onClick={ack}>
              Ack
            </button>
          )}
          {error && <span className="crit-t s">{error}</span>}
        </div>
      )}
    </div>
  );
}
