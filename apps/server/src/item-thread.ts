import { COMMS_CAPCOM, type ItemThread } from "@mc/core";
import type { CommsRow } from "./store/types.ts";

/**
 * A Needs-you item's conversation as the item shows it: each operator message says whether its
 * recipient has taken it and whether anyone has answered since.
 */
export function itemThread(rows: readonly CommsRow[]): ItemThread {
  return {
    messages: rows.map((row, i) => {
      const operator = row.from === COMMS_CAPCOM;
      const deliveredAt = row.deliveredAt ?? null;
      const answered = rows.slice(i + 1).some((later) => later.from !== COMMS_CAPCOM);
      return {
        id: row.id,
        at: row.at,
        from: row.from,
        to: row.to,
        text: row.text,
        operator,
        deliveredAt,
        ...(operator
          ? { state: answered ? "answered" : deliveredAt === null ? "stored" : "delivered" }
          : {}),
      };
    }),
  };
}
