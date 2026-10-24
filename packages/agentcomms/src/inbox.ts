import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Message, Sender } from "./envelope.ts";

export type InboxEntry = { seq: number; room: string; msg: Message; sender: Sender };
export type Thread = { thread: string; closed: boolean; question?: Message };
export interface Inbox {
  add(seq: number, room: string, msg: Message, sender: Sender): void;
  list(room: string, sinceSeq?: number): InboxEntry[];
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
    CREATE TABLE IF NOT EXISTS threads (
      room TEXT NOT NULL, thread TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
      question TEXT, PRIMARY KEY (room, thread)
    );
  `);
  const advance = (room: string, seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid inbox cursor");
    db.prepare(
      "INSERT INTO cursors (room, seq) VALUES (?, ?) ON CONFLICT(room) DO UPDATE SET seq = MAX(seq, excluded.seq)",
    ).run(room, seq);
  };
  return {
    advance,
    add(seq, room, msg, sender) {
      if (!Number.isSafeInteger(seq) || seq < 1 || msg.room !== room)
        throw new Error("Invalid inbox entry");
      db.exec("BEGIN IMMEDIATE");
      try {
        const added = db
          .prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?)")
          .run(room, seq, JSON.stringify(msg), JSON.stringify(sender));
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
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    list(room, sinceSeq = 0) {
      return db
        .prepare("SELECT * FROM messages WHERE room = ? AND seq > ? ORDER BY seq")
        .all(room, sinceSeq)
        .map((row) => ({
          seq: Number(row.seq),
          room: String(row.room),
          msg: JSON.parse(String(row.msg)),
          sender: JSON.parse(String(row.sender)),
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
