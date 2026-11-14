import { COMMS_CAPCOM, type ItemThread } from "@mc/core";
import type { CommsRow } from "./store/types.ts";

/**
 * A Needs-you item's conversation as the item shows it: each operator message says whether its
 * recipient has taken it and whether that recipient has answered since.
 */
export function itemThread(rows: readonly (CommsRow & { choice?: string })[]): ItemThread {
  return {
    messages: rows.map((row, i) => {
      const operator = row.from === COMMS_CAPCOM;
      const deliveredAt = row.deliveredAt ?? null;
      // answered by the one it was sent to, not by another seat writing in the same thread
      const answered = rows.slice(i + 1).some((later) => later.from === row.to);
      return {
        id: row.id,
        at: row.at,
        from: row.from,
        to: row.to,
        text: row.text,
        operator,
        deliveredAt,
        ...(row.choice !== undefined ? { choice: row.choice } : {}),
        // a pick is a record, not a message waiting to be read (as in the FLIGHT conversation)
        ...(operator && row.choice === undefined
          ? { state: answered ? "answered" : deliveredAt === null ? "stored" : "delivered" }
          : {}),
      };
    }),
  };
}
