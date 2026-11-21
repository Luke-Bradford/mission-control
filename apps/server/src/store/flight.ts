import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import {
  type AgentId,
  FLIGHT_INCOMING_LIMIT,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_MEMORY_FULL,
  FLIGHT_MEMORY_TOPICS_MAX,
  FLIGHT_PLAN_LIMIT,
  FLIGHT_POINTER_CHANGE_MAX,
  FLIGHT_WATCH_LIMIT,
  type FlightArrivalDisposition,
  type FlightDecision,
  type FlightDecisionKind,
  type FlightLedgerEntry,
  type FlightMemoryNote,
  type FlightMemoryTitle,
  type FlightMovedPointer,
  type FlightPlanInput,
  type FlightPlanOperation,
  type FlightPointer,
  type FlightPointerKind,
  type FlightWakeRecord,
  type FlightWatchEntry,
  type FlightWatchOperation,
  memoryTopicKey,
  validateMemoryNote,
} from "@mc/core";
import { toFlightDecision } from "./rows.ts";
import type { FlightBriefRow } from "./types.ts";

type Row = Record<string, SQLInputValue>;

/**
 * The queries over FLIGHT's own tables: the brief, decisions, incoming dispositions, ledger,
 * memory, plans, pointers, wakes and watch list. `transaction` and `statement` are the store's, so
 * a multi-table write lands as one transaction and hot reads reuse prepared statements.
 */
export function flightQueries(
  db: DatabaseSync,
  transaction: (fn: () => void) => void,
  statement: (sql: string) => StatementSync,
) {
  const flightPlans = (session: string): (FlightPlanInput & { createdAt: number })[] =>
    (
      db
        .prepare("SELECT entry FROM flight_plans WHERE session_id = ? ORDER BY id")
        .all(session) as Row[]
    ).map((r) => JSON.parse(r.entry as string) as FlightPlanInput & { createdAt: number });

  const flightWatch = (session: string): FlightWatchEntry[] =>
    (
      db
        .prepare("SELECT entry FROM flight_watch WHERE session_id = ? ORDER BY id")
        .all(session) as Row[]
    ).map((r) => JSON.parse(r.entry as string) as FlightWatchEntry);

  const prepareFlightPlans = (
    session: string,
    operation: FlightPlanOperation,
    at: number,
  ): (() => void) => {
    const plans = new Map(flightPlans(session).map((p) => [p.id, p]));
    for (const entry of operation.upsert ?? []) {
      if (entry.status === "completed" && !entry.detail?.trim())
        throw new Error("Completion needs an observed outcome.");
      plans.set(entry.id, { ...entry, createdAt: plans.get(entry.id)?.createdAt ?? at });
    }
    if ([...plans.values()].filter((p) => p.status === "pending").length > FLIGHT_PLAN_LIMIT)
      throw new Error("Too many planned entries.");
    const finished = [...plans.values()]
      .filter((p) => p.status !== "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const entry of finished.slice(0, Math.max(0, plans.size - FLIGHT_PLAN_LIMIT)))
      plans.delete(entry.id);
    return () => {
      db.prepare("DELETE FROM flight_plans WHERE session_id = ?").run(session);
      for (const entry of plans.values())
        db.prepare("INSERT INTO flight_plans (session_id, id, entry) VALUES (?, ?, ?)").run(
          session,
          entry.id,
          JSON.stringify(entry),
        );
    };
  };

  const prepareFlightWatch = (
    session: string,
    operation: FlightWatchOperation,
    at: number,
  ): (() => void) => {
    const watch = new Map(flightWatch(session).map((entry) => [entry.id, entry]));
    for (const id of operation.remove ?? []) watch.delete(id);
    for (const entry of operation.upsert ?? []) watch.set(entry.id, { ...entry, updatedAt: at });
    if (watch.size > FLIGHT_WATCH_LIMIT) throw new Error("Too many watch entries.");
    return () => {
      db.prepare("DELETE FROM flight_watch WHERE session_id = ?").run(session);
      for (const entry of watch.values())
        db.prepare("INSERT INTO flight_watch (session_id, id, entry) VALUES (?, ?, ?)").run(
          session,
          entry.id,
          JSON.stringify(entry),
        );
    };
  };

  /** Records one of FLIGHT's decisions; returns its id. */
  const addFlightDecision = (d: Omit<FlightDecision, "id">): number => {
    const r = db
      .prepare(
        `INSERT INTO flight_decisions
           (at, kind, seat_id, target_run_id, ref, question_id, about, decision, basis, order_id,
            wake_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.at,
        d.kind,
        d.seatId,
        d.targetRunId,
        d.ref,
        d.questionId,
        d.about,
        d.decision,
        d.basis,
        d.orderId ?? null,
        d.wakeId ?? null,
      );
    return Number(r.lastInsertRowid);
  };

  /** Makes the entry's pointers exactly `entry.pointers`; one that stays keeps its marks. */
  const syncFlightPointers = (session: string, entry: FlightLedgerEntry): void => {
    const pointers = entry.pointers ?? [];
    const kept = new Set(pointers.map((p) => `${p.kind}\0${p.target}`));
    const drop = db.prepare(
      "DELETE FROM flight_pointers WHERE session_id = ? AND entry_key = ? AND kind = ? AND target = ?",
    );
    for (const old of db
      .prepare("SELECT kind, target FROM flight_pointers WHERE session_id = ? AND entry_key = ?")
      .all(session, entry.key) as { kind: string; target: string }[]) {
      if (!kept.has(`${old.kind}\0${old.target}`))
        drop.run(session, entry.key, old.kind, old.target);
    }
    const add = db.prepare(
      `INSERT OR IGNORE INTO flight_pointers (session_id, entry_key, kind, target, changed_at, change, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of pointers)
      add.run(session, entry.key, p.kind, p.target, p.changedAt, p.change, p.readAt);
  };

  return {
    prepareFlightPlans,
    prepareFlightWatch,
    flightPlans,
    flightWatch,
    addFlightDecision,

    /** Stores a FLIGHT wake on the run it woke, with the fact categories that caused it. */
    addFlightWake(runId: string, at: number, reasons: string[], wakeId?: string): void {
      db.prepare(
        "INSERT OR REPLACE INTO flight_wakes (run_id, at, reasons, wake_id) VALUES (?, ?, ?, ?)",
      ).run(runId, at, JSON.stringify(reasons), wakeId ?? null);
    },

    /** The id of the run's latest wake; null when it has none or none was given an id. */
    latestFlightWakeId(runId: string): string | null {
      const row = db
        .prepare("SELECT wake_id FROM flight_wakes WHERE run_id = ? ORDER BY at DESC LIMIT 1")
        .get(runId) as { wake_id: string | null } | undefined;
      return row?.wake_id ?? null;
    },

    /** FLIGHT's wakes at or after `since`, oldest first. */
    flightWakes(since: number): FlightWakeRecord[] {
      const rows = db
        .prepare(
          "SELECT run_id, at, reasons, wake_id FROM flight_wakes WHERE at >= ? ORDER BY at, run_id",
        )
        .all(since) as {
        run_id: string;
        at: number;
        reasons: string;
        wake_id: string | null;
      }[];
      return rows.map((r) => ({
        runId: r.run_id,
        at: r.at,
        reasons: JSON.parse(r.reasons) as string[],
        ...(r.wake_id === null ? {} : { wakeId: r.wake_id }),
      }));
    },

    setFlightPlans(session: string, operation: FlightPlanOperation, at: number): void {
      const write = prepareFlightPlans(session, operation, at);
      transaction(write);
    },

    setFlightWatch(session: string, operation: FlightWatchOperation, at: number): void {
      const write = prepareFlightWatch(session, operation, at);
      transaction(write);
    },

    flightIncoming(): FlightArrivalDisposition[] {
      return (
        db
          .prepare("SELECT entry FROM flight_incoming ORDER BY at DESC, id DESC LIMIT ?")
          .all(FLIGHT_INCOMING_LIMIT) as Row[]
      ).map((r) => {
        const entry = JSON.parse(r.entry as string) as FlightArrivalDisposition;
        return { ...entry, repoId: entry.repoId ?? null, sourceRef: entry.sourceRef ?? null };
      });
    },

    /**
     * Records the operator's answer to a set-aside question where every later run on its ticket reads
     * it (`answeredQuestionsOn`). A repeat for the same question replaces the earlier text.
     */
    recordSetAsideAnswer(d: {
      at: number;
      seatId: AgentId;
      questionId: number;
      ref: string;
      about: string;
      decision: string;
    }): void {
      transaction(() => {
        db.prepare("DELETE FROM flight_decisions WHERE question_id = ? AND kind = 'answer'").run(
          d.questionId,
        );
        addFlightDecision({
          at: d.at,
          kind: "answer",
          seatId: d.seatId,
          targetRunId: null,
          ref: d.ref,
          questionId: d.questionId,
          about: d.about,
          decision: d.decision,
          basis: "Operator answered the set-aside question from its ticket.",
        });
      });
    },

    /** FLIGHT's decisions at or after `since`, newest first. */
    flightDecisions(since: number, limit: number): FlightDecision[] {
      const rows = db
        .prepare("SELECT * FROM flight_decisions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?")
        .all(since, limit) as Row[];
      return rows.map(toFlightDecision);
    },

    /** The decisions of one kind about one ticket, newest first. */
    flightDecisionsAbout(kind: FlightDecisionKind, ref: string): FlightDecision[] {
      const rows = db
        .prepare(
          "SELECT * FROM flight_decisions WHERE kind = ? AND ref = ? ORDER BY at DESC, id DESC",
        )
        .all(kind, ref) as Row[];
      return rows.map(toFlightDecision);
    },

    /** The newest `limit` FLIGHT decisions that name the ticket by ref or target one of its runs. */
    flightDecisionsOnTicket(
      ref: string,
      runIds: readonly string[],
      limit: number,
    ): FlightDecision[] {
      const byRef = db
        .prepare("SELECT * FROM flight_decisions WHERE ref = ? ORDER BY at DESC, id DESC LIMIT ?")
        .all(ref, limit) as Row[];
      const byRun = statement(
        "SELECT * FROM flight_decisions WHERE target_run_id = ? ORDER BY at DESC, id DESC LIMIT ?",
      );
      const seen = new Set<number>();
      const out: FlightDecision[] = [];
      for (const r of [...byRef, ...runIds.flatMap((id) => byRun.all(id, limit) as Row[])]) {
        if (seen.has(r.id as number)) continue;
        seen.add(r.id as number);
        out.push(toFlightDecision(r));
      }
      return out.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, limit);
    },

    /** How many decisions of these kinds since `since`, optionally for one seat, ref or run. */
    countFlightDecisions(q: {
      kinds: readonly FlightDecisionKind[];
      since: number;
      seatId?: string;
      ref?: string;
      targetRunId?: string;
    }): number {
      if (q.kinds.length === 0) return 0;
      const where = [`kind IN (${q.kinds.map(() => "?").join(", ")})`, "at >= ?"];
      const args: SQLInputValue[] = [...q.kinds, q.since];
      if (q.seatId !== undefined) {
        where.push("seat_id = ?");
        args.push(q.seatId);
      }
      if (q.ref !== undefined) {
        where.push("ref = ?");
        args.push(q.ref);
      }
      if (q.targetRunId !== undefined) {
        where.push("target_run_id = ?");
        args.push(q.targetRunId);
      }
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM flight_decisions WHERE ${where.join(" AND ")}`)
        .get(...args) as { n: number };
      return row.n;
    },

    /** Replaces one section of a session's brief. */
    setFlightBriefSection(r: FlightBriefRow): void {
      db.prepare(
        `INSERT INTO flight_brief (session_id, section, text, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, section) DO UPDATE SET
           text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(r.sessionId, r.section, r.text, r.updatedAt, r.updatedBy);
    },

    /** The stored sections of a session's brief. */
    flightBrief(sessionId: string): FlightBriefRow[] {
      const rows = db
        .prepare("SELECT * FROM flight_brief WHERE session_id = ? ORDER BY section")
        .all(sessionId) as Row[];
      return rows.map((r) => ({
        sessionId: r.session_id as string,
        section: r.section as FlightBriefRow["section"],
        text: r.text as string,
        updatedAt: r.updated_at as number,
        updatedBy: r.updated_by as string,
      }));
    },

    /** Lasting notes for one repo, in topic order. */
    flightMemory(repo: string): FlightMemoryNote[] {
      return (
        db
          .prepare("SELECT * FROM flight_memory WHERE repo_id = ? ORDER BY topic")
          .all(repo) as Row[]
      ).map((r) => ({
        repoId: r.repo_id as string,
        topic: r.topic as string,
        kind: r.kind as FlightMemoryNote["kind"],
        body: r.body as string,
        source: r.source as string,
        author: r.author as FlightMemoryNote["author"],
        updatedAt: r.updated_at as number,
      }));
    },

    /** The state index never reads note bodies. */
    flightMemoryTitles(repo: string): FlightMemoryTitle[] {
      return (
        db
          .prepare(
            "SELECT topic, kind, updated_at, author FROM flight_memory WHERE repo_id = ? ORDER BY topic",
          )
          .all(repo) as Row[]
      ).map((r) => ({
        topic: r.topic as string,
        kind: r.kind as FlightMemoryTitle["kind"],
        updatedAt: r.updated_at as number,
        author: r.author as FlightMemoryTitle["author"],
      }));
    },

    putFlightMemory(note: FlightMemoryNote): void {
      const parsed = validateMemoryNote(note);
      const key = memoryTopicKey(parsed.topic);
      transaction(() => {
        const exists = db
          .prepare("SELECT 1 FROM flight_memory WHERE repo_id = ? AND topic_key = ?")
          .get(note.repoId, key);
        const count = db
          .prepare("SELECT COUNT(*) AS n FROM flight_memory WHERE repo_id = ?")
          .get(note.repoId) as { n: number };
        if (!exists && count.n >= FLIGHT_MEMORY_TOPICS_MAX) throw new Error(FLIGHT_MEMORY_FULL);
        db.prepare(`INSERT INTO flight_memory (repo_id, topic, topic_key, kind, body, source, author, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, topic_key) DO UPDATE SET
        topic = excluded.topic, kind = excluded.kind, body = excluded.body, source = excluded.source,
        author = excluded.author, updated_at = excluded.updated_at`).run(
          note.repoId,
          parsed.topic,
          key,
          parsed.kind,
          parsed.body,
          parsed.source,
          parsed.author,
          note.updatedAt,
        );
      });
    },

    deleteFlightMemory(repo: string, topic: string): boolean {
      return (
        db
          .prepare("DELETE FROM flight_memory WHERE repo_id = ? AND topic_key = ?")
          .run(repo, memoryTopicKey(topic)).changes > 0
      );
    },

    /** The full ledger for one crew session, including retained closed entries. */
    flightLedger(session: string): FlightLedgerEntry[] {
      const pointers = new Map<string, FlightPointer[]>();
      for (const r of db
        .prepare(
          `SELECT entry_key, kind, target, changed_at, change, read_at FROM flight_pointers
         WHERE session_id = ? ORDER BY rowid`,
        )
        .all(session) as Row[]) {
        const list = pointers.get(r.entry_key as string) ?? [];
        list.push({
          kind: r.kind as FlightPointerKind,
          target: r.target as string,
          changedAt: r.changed_at as number | null,
          change: r.change as string | null,
          readAt: r.read_at as number | null,
        });
        pointers.set(r.entry_key as string, list);
      }
      return (
        db
          .prepare("SELECT entry FROM flight_ledger WHERE session_id = ? ORDER BY key")
          .all(session) as { entry: string }[]
      ).map((r) => {
        const entry = JSON.parse(r.entry) as FlightLedgerEntry;
        const held = pointers.get(entry.key);
        return held === undefined ? entry : { ...entry, pointers: held };
      });
    },

    /** Marks every pointer at `kind` and `target`, in any entry, as changed at `at`. */
    markFlightPointers(kind: FlightPointerKind, target: string, change: string, at: number): void {
      db.prepare(
        `UPDATE flight_pointers SET changed_at = ?, change = ?, changed_seq = (SELECT COALESCE(MAX(MAX(COALESCE(changed_seq, 0), COALESCE(read_seq, 0))), 0) + 1 FROM flight_pointers)
         WHERE kind = ? AND target = ?`,
      ).run(at, change.slice(0, FLIGHT_POINTER_CHANGE_MAX), kind, target);
    },

    /** The pointers of open entries whose target changed after FLIGHT last read them. */
    movedFlightPointers(session: string): FlightMovedPointer[] {
      const open = FLIGHT_LEDGER_OPEN.map(() => "?").join(", ");
      return (
        db
          .prepare(
            `SELECT p.entry_key, p.kind, p.target, p.changed_at, p.change FROM flight_pointers p
           JOIN flight_ledger l ON l.session_id = p.session_id AND l.key = p.entry_key
           WHERE p.session_id = ? AND l.status IN (${open}) AND p.changed_at IS NOT NULL
             AND p.changed_seq > COALESCE(p.read_seq, 0)
           ORDER BY p.changed_at, p.entry_key, p.kind, p.target`,
          )
          .all(session, ...FLIGHT_LEDGER_OPEN) as Row[]
      ).map((r) => ({
        entry: r.entry_key as string,
        kind: r.kind as FlightPointerKind,
        target: r.target as string,
        change: (r.change as string | null) ?? "",
        at: r.changed_at as number,
      }));
    },

    /**
     * FLIGHT has read the pointers in `moved` at `at`. A pointer marked again since (another time or
     * text) stays unread; changes are ordered by a counter, not by `at`, whose clock is the poll's.
     */
    markFlightPointersRead(
      session: string,
      moved: readonly FlightMovedPointer[],
      at: number,
    ): void {
      const stamp = db.prepare(
        `UPDATE flight_pointers SET read_at = ?, read_seq = (SELECT COALESCE(MAX(MAX(COALESCE(changed_seq, 0), COALESCE(read_seq, 0))), 0) + 1 FROM flight_pointers)
       WHERE session_id = ? AND entry_key = ? AND kind = ? AND target = ?
         AND changed_at = ? AND change = ?`,
      );
      transaction(() => {
        for (const m of moved) stamp.run(at, session, m.entry, m.kind, m.target, m.at, m.change);
      });
    },

    /** Save an entry and prune old closed entries across all sessions, in one transaction. */
    putFlightLedgerEntry(session: string, entry: FlightLedgerEntry, pruneBefore: number): void {
      transaction(() => {
        db.prepare(`INSERT INTO flight_ledger (session_id, key, kind, status, updated_at, entry)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET
        kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, entry = excluded.entry`).run(
          session,
          entry.key,
          entry.kind,
          entry.status,
          entry.updatedAt,
          JSON.stringify({ ...entry, pointers: undefined }),
        );
        if (entry.pointers !== undefined) syncFlightPointers(session, entry);
        db.prepare(`DELETE FROM flight_ledger WHERE updated_at < ?
        AND status NOT IN (${FLIGHT_LEDGER_OPEN.map(() => "?").join(", ")})`).run(
          pruneBefore,
          ...FLIGHT_LEDGER_OPEN,
        );
        db.prepare(
          `DELETE FROM flight_pointers WHERE NOT EXISTS (
             SELECT 1 FROM flight_ledger l
             WHERE l.session_id = flight_pointers.session_id AND l.key = flight_pointers.entry_key)`,
        ).run();
      });
    },
  };
}
