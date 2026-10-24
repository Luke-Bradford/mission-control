import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Message, Sealed, Sender } from "./envelope.ts";

export type InboxEntry = {
  seq: number;
  room: string;
  msg: Message | null;
  quarantined?: boolean;
  reason?: string;
  sender: Sender & { member?: { id: string; label: string } };
};
export type Thread = { thread: string; closed: boolean; question?: Message };
export interface Inbox {
  add(seq: number, room: string, msg: Message, sender: InboxEntry["sender"]): boolean;
  quarantine(seq: number, room: string, sealed: Sealed, reason: string): void;
  list(room: string, sinceSeq?: number, limit?: number): InboxEntry[];
  lastSeq(room: string): number;
  advance(room: string, seq: number): void;
  threads(room: string): Thread[];
  close(thread: string): void;
  dispose(): void;
}

export function openInbox(path: string): Inbox {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cursors (room TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      room TEXT NOT NULL, seq INTEGER NOT NULL, msg TEXT NOT NULL, sender TEXT NOT NULL,
      PRIMARY KEY (room, seq)
    );
    CREATE TABLE IF NOT EXISTS quarantine (
      room TEXT NOT NULL, seq INTEGER NOT NULL, sealed TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY (room, seq)
    );
    CREATE TABLE IF NOT EXISTS threads (
      room TEXT NOT NULL, thread TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
      question TEXT, PRIMARY KEY (room, thread)
    );
  `);
  if (
    !db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .some((row) => row.name === "msg_id")
  ) {
    db.exec("ALTER TABLE messages ADD COLUMN msg_id TEXT");
    db.exec("UPDATE messages SET msg_id = json_extract(msg, '$.id')");
    db.exec(
      "DELETE FROM messages WHERE rowid NOT IN (SELECT MIN(rowid) FROM messages GROUP BY room, msg_id)",
    );
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_id ON messages(room, msg_id)");
  const advance = (room: string, seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid inbox cursor");
    db.prepare(
      "INSERT INTO cursors (room, seq) VALUES (?, ?) ON CONFLICT(room) DO UPDATE SET seq = MAX(seq, excluded.seq)",
    ).run(room, seq);
  };
  return {
    advance,
    quarantine(seq, room, sealed, reason) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO quarantine VALUES (?, ?, ?, ?)").run(
          room,
          seq,
          JSON.stringify(sealed),
          reason.slice(0, 500),
        );
        advance(room, seq);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    add(seq, room, msg, sender) {
      if (!Number.isSafeInteger(seq) || seq < 1 || msg.room !== room)
        throw new Error("Invalid inbox entry");
      db.exec("BEGIN IMMEDIATE");
      try {
        const added = db
          .prepare(
            "INSERT OR IGNORE INTO messages (room, seq, msg, sender, msg_id) VALUES (?, ?, ?, ?, ?)",
          )
          .run(room, seq, JSON.stringify(msg), JSON.stringify(sender), msg.id);
        if (added.changes) {
          db.prepare("INSERT OR IGNORE INTO threads (room, thread) VALUES (?, ?)").run(
            room,
            msg.thread,
          );
          if (msg.kind === "question") {
            db.prepare(
              "UPDATE threads SET question = COALESCE(question, ?) WHERE room = ? AND thread = ?",
            ).run(JSON.stringify(msg), room, msg.thread);
          }
          if (msg.kind === "answer" || msg.kind === "decision") {
            db.prepare("UPDATE threads SET closed = 1 WHERE room = ? AND thread = ?").run(
              room,
              msg.thread,
            );
          }
        }
        advance(room, seq);
        db.exec("COMMIT");
        return Boolean(added.changes);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    list(room, sinceSeq = 0, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error("Invalid limit");
      return db
        .prepare(`SELECT seq, msg, sender, NULL AS reason FROM messages WHERE room = ? AND seq > ?
        UNION ALL SELECT seq, NULL AS msg, json_extract(sealed, '$.sender') AS sender, reason FROM quarantine WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?`)
        .all(room, sinceSeq, room, sinceSeq, limit)
        .map((row) => ({
          seq: Number(row.seq),
          room,
          msg: row.msg ? JSON.parse(String(row.msg)) : null,
          sender: JSON.parse(String(row.sender)),
          ...(row.reason ? { quarantined: true, reason: String(row.reason) } : {}),
        }));
    },
    lastSeq(room) {
      return Number(
        db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM (SELECT seq FROM messages WHERE room = ? UNION ALL SELECT seq FROM cursors WHERE room = ?)",
          )
          .get(room, room)?.seq,
      );
    },
    threads(room) {
      return db
        .prepare("SELECT * FROM threads WHERE room = ? ORDER BY rowid")
        .all(room)
        .map((row) => ({
          thread: String(row.thread),
          closed: Boolean(row.closed),
          ...(row.question ? { question: JSON.parse(String(row.question)) as Message } : {}),
        }));
    },
    close(thread) {
      db.prepare("UPDATE threads SET closed = 1 WHERE thread = ?").run(thread);
    },
    dispose() {
      db.close();
    },
  };
}
