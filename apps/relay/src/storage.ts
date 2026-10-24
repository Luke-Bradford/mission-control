import type { RoomState, RoomStorage } from "../../../packages/agentcomms/src/relay-core.ts";

type SQLiteStorage = {
  sql: { exec(query: string, ...bindings: (string | number)[]): Iterable<Record<string, unknown>> };
  transactionSync<T>(fn: () => T): T;
};

export function createDOStorage(storage: SQLiteStorage): RoomStorage {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS room_state (part INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  );
  return {
    load() {
      const rows = [...storage.sql.exec("SELECT value FROM room_state ORDER BY part")];
      return rows.length
        ? (JSON.parse(rows.map((row) => row.value).join("")) as RoomState)
        : undefined;
    },
    save(state) {
      const json = JSON.stringify(state);
      // Split snapshots so a 5000-message log cannot exceed the storage limit for one row.
      storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM room_state");
        let part = 0;
        for (let offset = 0; offset < json.length; ) {
          let end = Math.min(offset + 16_000, json.length);
          const last = json.charCodeAt(end - 1);
          if (last >= 0xd800 && last <= 0xdbff) end--;
          storage.sql.exec(
            "INSERT INTO room_state (part, value) VALUES (?, ?)",
            part++,
            json.slice(offset, end),
          );
          offset = end;
        }
      });
    },
  };
}
