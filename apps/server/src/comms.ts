import { COMMS_CAPCOM, COMMS_MC, type CommsThreadMessage } from "@mc/core";
import { commsPosition, type Store } from "./store.ts";
import { readStream } from "./stream.ts";

/** A thread scans at most three transcripts, with 200 events per transcript. */
const THREAD_RUNS = 3;

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
  const cursors = store.threadReadCursors(id);
  return messages
    .sort((a, b) => {
      if (a.at === null) return b.at === null ? 0 : 1;
      return b.at === null ? -1 : a.at - b.at;
    })
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
