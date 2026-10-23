import { COMMS_CAPCOM, COMMS_MC, type CommsThreadMessage } from "@mc/core";
import { commsPosition, type Store } from "./store.ts";
import { readStream } from "./stream.ts";

/** A thread scans at most three transcripts, with 200 events per transcript. */
const THREAD_RUNS = 3;

/** Shared ceiling for a displayed snapshot and its read acknowledgement. */
export const COMMS_SNAPSHOT_LIMIT = 10200;

/** Needs you scans only the newest run; the thread retains a small recent history. */
export function threadMessages(
  store: Store,
  id: string,
  crew: boolean,
  scope: "thread" | "attention" = "thread",
): CommsThreadMessage[] {
  const rows = store.threadComms(id).sort((a, b) => a.at - b.at);
  const prompt = rows.findLast((m) => m.from === COMMS_CAPCOM && m.to === id);
  const messages: Omit<CommsThreadMessage, "seen">[] = rows.map((m) => ({
    ...m,
    tagged: m.from !== COMMS_CAPCOM && m.from !== COMMS_MC && /@CAPCOM\b/i.test(m.text),
    direct:
      m.to === COMMS_CAPCOM &&
      m.from === id &&
      prompt !== undefined &&
      (m.at > prompt.at ||
        (m.at === prompt.at &&
          Number(m.id.slice("comms:".length)) > Number(prompt.id.slice("comms:".length)))),
  }));
  for (const run of store.runs(id, scope === "attention" ? 1 : THREAD_RUNS).reverse()) {
    if (!run.transcriptPath) continue;
    try {
      for (const event of readStream(run.transcriptPath, 200).events) {
        if (event.kind !== "msg") continue;
        messages.push({
          id: `stream:${run.id}:${event.id}`,
          at: event.at,
          from: id,
          to: COMMS_CAPCOM,
          ticket: run.ticket,
          text: event.text,
          tagged: /@CAPCOM\b/i.test(event.text),
          // Observed loop stdout is not the crew's direct line to CAPCOM.
          // An undated event is only known to follow prompts older than its run.
          direct: crew && prompt !== undefined && (event.at ?? run.startedAt) > prompt.at,
        });
      }
    } catch {
      // A missing transcript contributes no messages.
    }
  }
  // Give undated messages a neighbouring time in their own source, without changing
  // their public timestamp. Source positions break ties within that time.
  const sourceTimes = new Map<string, number>();
  const orderTimes = new Map<string, number>();
  for (const m of messages) {
    const p = commsPosition(m.id);
    if (!p) continue;
    if (m.at !== null) sourceTimes.set(p.source, m.at);
    const at = m.at ?? sourceTimes.get(p.source);
    if (at !== undefined) orderTimes.set(m.id, at);
  }
  sourceTimes.clear();
  for (const m of messages.toReversed()) {
    const p = commsPosition(m.id);
    if (!p) continue;
    if (m.at !== null) sourceTimes.set(p.source, m.at);
    if (!orderTimes.has(m.id)) orderTimes.set(m.id, sourceTimes.get(p.source) ?? 0);
  }
  const cursors = store.threadReadCursors(id);
  return messages
    .sort((a, b) => {
      const time = (orderTimes.get(a.id) ?? 0) - (orderTimes.get(b.id) ?? 0);
      if (time !== 0) return time;
      const ap = commsPosition(a.id);
      const bp = commsPosition(b.id);
      return ap && bp && ap.source === bp.source ? ap.offset - bp.offset || ap.block - bp.block : 0;
    })
    .slice(-COMMS_SNAPSHOT_LIMIT)
    .map((m) => {
      const position = commsPosition(m.id);
      if (position === null) return { ...m, seen: false };
      const cursor = cursors.get(position.source);
      const seen =
        cursor !== undefined &&
        (position.offset < cursor.offset ||
          (position.offset === cursor.offset && position.block <= cursor.block));
      return { ...m, seen };
    });
}
