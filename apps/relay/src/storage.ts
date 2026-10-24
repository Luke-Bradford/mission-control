import { LOG_LIMIT } from "../../../packages/agentcomms/src/limits.ts";
import type { Entry, RoomState, RoomStorage } from "../../../packages/agentcomms/src/relay-core.ts";

type SQLiteStorage = {
  sql: { exec(query: string, ...bindings: (string | number)[]): Iterable<Record<string, unknown>> };
  transactionSync<T>(fn: () => T): T;
};

type Header = Pick<RoomState, "room" | "keyEpoch" | "seq"> & {
  ownerId: string;
  signedDirectory?: Omit<NonNullable<RoomState["signedDirectory"]>, "members" | "activeMemberIds">;
};

// Read old chunked snapshots one field (or log entry) at a time during migration.
function* legacyFields(chunks: Iterable<Record<string, unknown>>) {
  let key = "";
  let value = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let log = false;
  for (const chunk of chunks) {
    for (const char of String(chunk.value)) {
      if (!key && depth === 1 && char === ":" && !quoted) {
        key = JSON.parse(value.trim());
        value = "";
        continue;
      }
      if (key === "log" && !log && char === "[" && depth === 1 && !quoted) {
        log = true;
        value = "";
        continue;
      }
      if (!quoted && depth === 1 && (char === "," || char === "}" || (log && char === "]"))) {
        if (key && value.trim()) yield { key, value: JSON.parse(value) };
        value = "";
        if (!log || char === "]") key = "";
        if (char === "]") log = false;
        if (char === "}") depth--;
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      if (depth > 1 || key || char !== "{") value += char;
    }
  }
  if (depth !== 0 || quoted || key || log || value.trim())
    throw new Error("Invalid legacy room snapshot");
}

export function createDOStorage(storage: SQLiteStorage): RoomStorage {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS room_rows (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))",
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS room_log (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  );
  let previous = new Map<string, string>();
  const rowsFor = (state: RoomState) => {
    const rows = new Map<string, string>();
    const put = (kind: string, id: string, value: unknown) =>
      rows.set(JSON.stringify([kind, id]), JSON.stringify(value));
    const {
      members,
      activeMemberIds: _,
      ...signedDirectory
    } = state.signedDirectory ?? {
      members: [],
      activeMemberIds: [],
    };
    put("header", "room", {
      room: state.room,
      keyEpoch: state.keyEpoch,
      seq: state.seq,
      ownerId: state.owner.id,
      signedDirectory: state.signedDirectory ? signedDirectory : undefined,
    });
    for (const [kind, entries] of [
      ["members", state.members],
      ["pending", state.pending],
      ["directory", state.directory ?? state.members],
      ["signedMembers", members],
    ] as const)
      for (const [index, member] of entries.entries()) put(kind, String(index), member);
    for (const grant of state.grants)
      put("grants", JSON.stringify([grant.memberId, grant.keyEpoch]), grant);
    for (const [token, value] of Object.entries(state.tokens)) put("tokens", token, value);
    for (const request of state.usedRequests ?? []) {
      // Legacy nonces have no timestamp; retain them for one expiry window after migration.
      const value = typeof request === "string" ? { nonce: request, at: Date.now() } : request;
      put("requests", value.nonce, value);
    }
    for (const [id, times] of Object.entries(state.postRates ?? {})) put("postRates", id, times);
    return rows;
  };
  const writeRows = (rows: Map<string, string>) => {
    for (const [key, value] of rows) {
      if (previous.get(key) === value) continue;
      const [kind, id] = JSON.parse(key) as [string, string];
      storage.sql.exec("INSERT OR REPLACE INTO room_rows VALUES (?, ?, ?)", kind, id, value);
    }
    for (const key of previous.keys()) {
      if (rows.has(key)) continue;
      const [kind, id] = JSON.parse(key) as [string, string];
      storage.sql.exec("DELETE FROM room_rows WHERE kind = ? AND id = ?", kind, id);
    }
  };
  const append = (entry: Entry) => {
    storage.sql.exec(
      "INSERT INTO room_log (seq, value) VALUES (?, ?)",
      entry.seq,
      JSON.stringify(entry.sealed),
    );
    storage.sql.exec("DELETE FROM room_log WHERE seq <= ?", entry.seq - LOG_LIMIT);
  };
  const legacy = [...storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'room_state'")];
  if (legacy.length) {
    storage.transactionSync(() => {
      const state = { log: [], presence: {} } as unknown as RoomState;
      let found = false;
      for (const field of legacyFields(
        storage.sql.exec("SELECT value FROM room_state ORDER BY part"),
      )) {
        found = true;
        if (field.key === "log") append(field.value as Entry);
        else Object.assign(state, { [field.key]: field.value });
      }
      if (found) writeRows(rowsFor(state));
      storage.sql.exec("DROP TABLE room_state");
    });
  }
  return {
    load() {
      const groups = new Map<string, { id: string; value: unknown }[]>();
      previous = new Map();
      for (const row of storage.sql.exec(
        "SELECT kind, id, value FROM room_rows ORDER BY kind, CAST(id AS INTEGER)",
      )) {
        const kind = String(row.kind);
        const id = String(row.id);
        const value = String(row.value);
        previous.set(JSON.stringify([kind, id]), value);
        const group = groups.get(kind) ?? [];
        group.push({ id, value: JSON.parse(value) });
        groups.set(kind, group);
      }
      const header = groups.get("header")?.[0]?.value as Header | undefined;
      if (!header) return undefined;
      const values = <T>(kind: string) => (groups.get(kind) ?? []).map((row) => row.value as T);
      const members = values<RoomState["members"][number]>("members");
      const signedMembers = values<RoomState["members"][number]>("signedMembers");
      const owner = members.find((m) => m.id === header.ownerId);
      if (!owner) throw new Error("Missing room owner");
      return {
        room: header.room,
        keyEpoch: header.keyEpoch,
        seq: header.seq,
        owner,
        members,
        directory: values("directory"),
        signedDirectory: header.signedDirectory && {
          ...header.signedDirectory,
          members: signedMembers,
          activeMemberIds: signedMembers.map((m) => m.id),
        },
        pending: values("pending"),
        tokens: Object.fromEntries(
          (groups.get("tokens") ?? []).map((row) => [row.id, row.value]),
        ) as RoomState["tokens"],
        usedRequests: values<string | { nonce: string; at: number }>("requests").map((request) =>
          typeof request === "string" ? { nonce: request, at: Date.now() } : request,
        ),
        postRates: Object.fromEntries(
          (groups.get("postRates") ?? []).map((row) => [row.id, row.value]),
        ) as RoomState["postRates"],
        grants: values("grants"),
        log: [],
        presence: {},
      };
    },
    save(state, entry) {
      const rows = rowsFor(state);
      storage.transactionSync(() => {
        writeRows(rows);
        if (entry) append(entry);
      });
      previous = rows;
    },
    readLog(seq, limit) {
      return [
        ...storage.sql.exec(
          "SELECT seq, value FROM room_log WHERE seq > ? ORDER BY seq LIMIT ?",
          seq,
          limit,
        ),
      ].map((row) => ({
        seq: Number(row.seq),
        sealed: JSON.parse(String(row.value)),
      }));
    },
  };
}
