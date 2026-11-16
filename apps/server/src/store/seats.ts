import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import {
  type AgentId,
  type ChoiceTargetKind,
  FLIGHT_WAKE_HEAD,
  type QuestionClosure,
  type QuestionClosureKind,
  type RepoId,
  type SeatSessionRow,
  wakeKeyPrefix,
} from "@mc/core";
import { compactFlightWake, queueRow, seatRow, toQuestion } from "./rows.ts";
import {
  ACTIVE_SEAT_STATES,
  commsMessageNumber,
  type QuestionChoiceRow,
  type QueueRow,
  type SeatLine,
  type SeatLineOrigin,
  type SeatQuestion,
} from "./types.ts";

type Row = Record<string, SQLInputValue>;

const choiceOf = (r: Row): QuestionChoiceRow => ({
  key: r.key as string,
  briefAt: r.brief_at as number,
  optionId: r.option_id as string,
  label: r.label as string,
  answer: r.answer as string,
  question: r.question as string,
  ticket: (r.ticket as string | null) ?? null,
  target: r.target as string,
  targetKind: r.target_kind as ChoiceTargetKind,
  messageId: r.message_id == null ? null : `comms:${r.message_id}`,
  chosenBy: (r.chosen_by as string | null) ?? "the operator",
  chosenAt: r.chosen_at as number,
});

const closureOf = (r: Row): QuestionClosure => ({
  key: r.key as string,
  askAt: r.ask_at as number,
  kind: r.kind as QuestionClosureKind,
  reason: r.reason as string,
  by: r.by as string,
  question: r.question as string,
  ticket: (r.ticket as string | null) ?? null,
  operator: r.operator === 1,
  at: r.at as number,
});

/**
 * The queries over the seat tables: seat questions, their choices and closures, seat sessions,
 * claimed seat lines and the queues. `transaction` and `statement` are the store's, so a
 * multi-statement write lands as one transaction and a hot read reuses a prepared statement.
 */
export function seatQueries(
  db: DatabaseSync,
  transaction: (fn: () => void, writeLock?: boolean) => void,
  statement: (sql: string) => StatementSync,
) {
  const choice = (key: string, briefAt: number): QuestionChoiceRow | null => {
    const r = db
      .prepare("SELECT * FROM question_choices WHERE key = ? AND brief_at = ?")
      .get(key, briefAt) as Row | undefined;
    return r ? choiceOf(r) : null;
  };

  const queue = (seatId: string): QueueRow[] => {
    const rows = db
      .prepare("SELECT * FROM queues WHERE seat_id = ? ORDER BY pos")
      .all(seatId) as Row[];
    return rows.map(queueRow);
  };

  const answerQuestion = (id: number, at: number): void => {
    db.prepare(
      "UPDATE seat_questions SET answered_at = ? WHERE id = ? AND answered_at IS NULL",
    ).run(at, id);
  };

  /** `closeQuestion` without its own transaction, for a caller already in one. */
  const insertClosure = (c: QuestionClosure): boolean => {
    const r = db
      .prepare(
        `INSERT INTO question_closures (key, ask_at, kind, reason, by, question, ticket, operator, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key, ask_at) DO NOTHING`,
      )
      .run(c.key, c.askAt, c.kind, c.reason, c.by, c.question, c.ticket, c.operator ? 1 : 0, c.at);
    const stored = Number(r.changes) > 0;
    const ask = /^ask:(\d+)$/.exec(c.key);
    if (stored && ask !== null) answerQuestion(Number(ask[1]), c.at);
    return stored;
  };

  return {
    choice,
    queue,
    answerQuestion,
    insertClosure,

    claimLine(key: string, line: SeatLine): boolean {
      let text = line.text;
      if (
        line.origin === "engine" &&
        key.startsWith(wakeKeyPrefix(line.runId)) &&
        text.startsWith(FLIGHT_WAKE_HEAD)
      ) {
        text = compactFlightWake(text);
      }
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO seat_lines (key, run_id, seat_id, origin, text, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(key, line.runId, line.seatId, line.origin, text, line.at);
      return r.changes === 1;
    },

    dropLine(key: string): void {
      db.prepare("DELETE FROM seat_lines WHERE key = ?").run(key);
    },

    claimedKeys(runId: string): Record<string, number> {
      const rows = db.prepare("SELECT key, at FROM seat_lines WHERE run_id = ?").all(runId) as {
        key: string;
        at: number;
      }[];
      return Object.fromEntries(rows.map((r) => [r.key, r.at]));
    },

    lastEngineLineAt(runId: string): number | null {
      const r = db
        .prepare("SELECT MAX(at) AS at FROM seat_lines WHERE run_id = ? AND origin = ?")
        .get(runId, "engine" satisfies SeatLineOrigin) as { at: number | null };
      return r.at;
    },

    claimChoice(c: QuestionChoiceRow): { row: QuestionChoiceRow; fresh: boolean } {
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO question_choices
           (key, brief_at, option_id, label, answer, question, ticket, target, target_kind, message_id, chosen_at, chosen_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          c.key,
          c.briefAt,
          c.optionId,
          c.label,
          c.answer,
          c.question,
          c.ticket,
          c.target,
          c.targetKind,
          c.messageId === null ? null : commsMessageNumber(c.messageId),
          c.chosenAt,
          c.chosenBy,
        );
      const row = choice(c.key, c.briefAt);
      if (row === null) throw new Error("Choice was not stored.");
      return { row, fresh: Number(r.changes) > 0 };
    },

    setChoiceMessage(key: string, briefAt: number, messageId: string): void {
      const n = commsMessageNumber(messageId);
      if (n !== null)
        db.prepare("UPDATE question_choices SET message_id = ? WHERE key = ? AND brief_at = ?").run(
          n,
          key,
          briefAt,
        );
    },

    isChoiceAnswer(messageId: string): boolean {
      const n = commsMessageNumber(messageId);
      return (
        n !== null &&
        db.prepare("SELECT 1 FROM question_choices WHERE message_id = ?").get(n) !== undefined
      );
    },

    releaseChoice(key: string, briefAt: number): void {
      db.prepare("DELETE FROM question_choices WHERE key = ? AND brief_at = ?").run(key, briefAt);
    },

    latestChoice(key: string): QuestionChoiceRow | null {
      const r = db
        .prepare("SELECT * FROM question_choices WHERE key = ? ORDER BY chosen_at DESC LIMIT 1")
        .get(key) as Row | undefined;
      return r ? choiceOf(r) : null;
    },

    choicesOnTicket(ticket: string, limit: number): QuestionChoiceRow[] {
      return (
        db
          .prepare(
            "SELECT * FROM question_choices WHERE ticket = ? ORDER BY chosen_at DESC LIMIT ?",
          )
          .all(ticket, limit) as Row[]
      ).map(choiceOf);
    },

    replaceQueues(queues: { seatId: string; items: { repoId: RepoId; issue: number }[] }[]): void {
      transaction(() => {
        const del = db.prepare("DELETE FROM queues WHERE seat_id = ? AND taken_at IS NULL");
        for (const q of queues) del.run(q.seatId);
        const queuedElsewhere = db.prepare(
          "SELECT 1 FROM queues WHERE repo_id = ? AND issue = ? AND seat_id != ?",
        );
        const ins = db.prepare(
          "INSERT INTO queues (seat_id, pos, repo_id, issue, taken_at) VALUES (?, ?, ?, ?, NULL)",
        );
        for (const { seatId, items } of queues) {
          const kept = queue(seatId);
          const held = new Set(kept.map((q) => `${q.repoId}#${q.issue}`));
          let pos = kept.reduce((max, q) => Math.max(max, q.pos), -1) + 1;
          for (const i of items) {
            const ref = `${i.repoId}#${i.issue}`;
            if (held.has(ref) || queuedElsewhere.get(i.repoId, i.issue, seatId)) continue;
            held.add(ref);
            ins.run(seatId, pos++, i.repoId, i.issue);
          }
        }
      }, true);
    },

    takeQueued(seatId: string, at: number, between?: () => void): QueueRow | null {
      let taken: QueueRow | null = null;
      transaction(() => {
        const held = db
          .prepare("SELECT 1 FROM queues WHERE seat_id = ? AND taken_at IS NOT NULL")
          .get(seatId);
        if (held) return;
        const head = db
          .prepare("SELECT * FROM queues WHERE seat_id = ? ORDER BY pos LIMIT 1")
          .get(seatId) as Row | undefined;
        if (!head) return;
        between?.();
        db.prepare("UPDATE queues SET taken_at = ? WHERE seat_id = ? AND pos = ?").run(
          at,
          seatId,
          head.pos as number,
        );
        taken = { ...queueRow(head), takenAt: at };
      }, true);
      return taken;
    },

    untake(seatId: string, repoId: RepoId, issue: number): void {
      db.prepare(
        "UPDATE queues SET taken_at = NULL WHERE seat_id = ? AND repo_id = ? AND issue = ?",
      ).run(seatId, repoId, issue);
    },

    dropQueued(seatId: string, repoId: RepoId, issue: number): void {
      db.prepare("DELETE FROM queues WHERE seat_id = ? AND repo_id = ? AND issue = ?").run(
        seatId,
        repoId,
        issue,
      );
    },

    staleTakes(before: number): QueueRow[] {
      const rows = db
        .prepare(
          "SELECT * FROM queues WHERE taken_at IS NOT NULL AND taken_at < ? ORDER BY taken_at, seat_id",
        )
        .all(before) as Row[];
      return rows.map(queueRow);
    },

    seatSession(seatId: string): SeatSessionRow | null {
      const r = db.prepare("SELECT * FROM seat_sessions WHERE seat_id = ?").get(seatId) as
        | Row
        | undefined;
      return r ? seatRow(r) : null;
    },

    seatSessions(seatIds: readonly AgentId[]): Map<AgentId, SeatSessionRow> {
      const out = new Map<AgentId, SeatSessionRow>();
      if (seatIds.length === 0) return out;
      const rows = statement(
        `SELECT * FROM seat_sessions WHERE seat_id IN (${seatIds.map(() => "?").join(", ")})`,
      ).all(...seatIds) as Row[];
      for (const row of rows) {
        const seat = seatRow(row);
        out.set(seat.seatId, seat);
      }
      return out;
    },

    setSeatSession(row: SeatSessionRow): void {
      db.prepare(
        `INSERT INTO seat_sessions (seat_id, run_id, cli_session_id, state, reason, worktree, updated_at, error_since, vendor, stop_by, stop_reason, stop_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seat_id) DO UPDATE SET run_id = excluded.run_id,
           cli_session_id = excluded.cli_session_id, state = excluded.state, vendor = excluded.vendor,
           reason = excluded.reason, worktree = excluded.worktree, updated_at = excluded.updated_at,
           stop_by = CASE WHEN excluded.state = 'stopped' THEN excluded.stop_by ELSE NULL END,
           stop_reason = CASE WHEN excluded.state = 'stopped' THEN excluded.stop_reason ELSE NULL END,
           stop_at = CASE WHEN excluded.state = 'stopped' THEN excluded.stop_at ELSE NULL END,
           error_since = CASE WHEN excluded.state != 'error' THEN NULL
             WHEN seat_sessions.state = 'error' THEN COALESCE(seat_sessions.error_since, seat_sessions.updated_at)
             ELSE excluded.updated_at END,
           quiet_turns = CASE WHEN seat_sessions.run_id IS excluded.run_id THEN seat_sessions.quiet_turns ELSE 0 END`,
      ).run(
        row.seatId,
        row.runId,
        row.cliSessionId,
        row.state,
        row.reason,
        row.worktree,
        row.updatedAt,
        row.state === "error" ? row.updatedAt : null,
        row.vendor ?? "claude",
        row.stop?.by ?? null,
        row.stop?.reason ?? null,
        row.stop?.at ?? null,
      );
    },

    setSeatTurnStarted(seatId: string, at: number): void {
      db.prepare("UPDATE seat_sessions SET last_turn_started_at = ? WHERE seat_id = ?").run(
        at,
        seatId,
      );
    },

    activeSeatSessions(): SeatSessionRow[] {
      const rows = db
        .prepare("SELECT * FROM seat_sessions WHERE run_id IS NOT NULL ORDER BY seat_id ASC")
        .all() as Row[];
      return rows.map(seatRow).filter((r) => ACTIVE_SEAT_STATES.includes(r.state));
    },

    addQuestion(q: Omit<SeatQuestion, "id" | "passedAt" | "asideAt">): number {
      const r = db
        .prepare("INSERT INTO seat_questions (agent_id, run_id, text, at) VALUES (?, ?, ?, ?)")
        .run(q.agentId, q.runId, q.text, q.at);
      return Number(r.lastInsertRowid);
    },

    questionTimes(agentId: AgentId): Set<number> {
      const rows = db.prepare("SELECT at FROM seat_questions WHERE agent_id = ?").all(agentId) as {
        at: number;
      }[];
      return new Set(rows.map((r) => r.at));
    },

    openQuestions(): SeatQuestion[] {
      const rows = db
        .prepare(
          "SELECT * FROM seat_questions WHERE answered_at IS NULL AND aside_at IS NULL ORDER BY id ASC",
        )
        .all() as Row[];
      return rows.map(toQuestion);
    },

    asideQuestions(): SeatQuestion[] {
      const rows = db
        .prepare(
          "SELECT * FROM seat_questions WHERE answered_at IS NULL AND aside_at IS NOT NULL ORDER BY id ASC",
        )
        .all() as Row[];
      return rows.map(toQuestion);
    },

    questionsOverlapping(
      agentId: AgentId,
      from: number,
      to: number,
    ): { at: number; answeredAt: number | null }[] {
      const rows = db
        .prepare(
          `SELECT at, answered_at FROM seat_questions
         WHERE agent_id = ? AND at < ? AND (answered_at IS NULL OR answered_at > ?) ORDER BY id`,
        )
        .all(agentId, to, from) as Row[];
      return rows.map((r) => ({ at: r.at as number, answeredAt: r.answered_at as number | null }));
    },

    question(id: number): (SeatQuestion & { answeredAt: number | null }) | null {
      const r = db.prepare("SELECT * FROM seat_questions WHERE id = ?").get(id) as Row | undefined;
      return r ? { ...toQuestion(r), answeredAt: r.answered_at as number | null } : null;
    },

    setQuestionAside(id: number, at: number): boolean {
      const r = db
        .prepare(
          "UPDATE seat_questions SET aside_at = ? WHERE id = ? AND answered_at IS NULL AND aside_at IS NULL",
        )
        .run(at, id);
      return Number(r.changes) > 0;
    },

    clearQuestionAside(id: number): boolean {
      const r = db
        .prepare(
          "UPDATE seat_questions SET aside_at = NULL WHERE id = ? AND answered_at IS NULL AND aside_at IS NOT NULL",
        )
        .run(id);
      return Number(r.changes) > 0;
    },

    passQuestion(id: number, at: number): boolean {
      const r = db
        .prepare(
          "UPDATE seat_questions SET passed_at = ? WHERE id = ? AND answered_at IS NULL AND passed_at IS NULL",
        )
        .run(at, id);
      return Number(r.changes) > 0;
    },

    unpassQuestion(id: number): boolean {
      const r = db
        .prepare(
          "UPDATE seat_questions SET passed_at = NULL WHERE id = ? AND answered_at IS NULL AND passed_at IS NOT NULL",
        )
        .run(id);
      return Number(r.changes) > 0;
    },

    answerQuestions(agentId: AgentId, at: number, unpassedOnly = false): void {
      db.prepare(
        `UPDATE seat_questions SET answered_at = ? WHERE agent_id = ? AND answered_at IS NULL${
          unpassedOnly ? " AND passed_at IS NULL" : ""
        }`,
      ).run(at, agentId);
    },

    answerRunQuestions(runId: string, at: number, unpassedOnly = false): void {
      db.prepare(
        `UPDATE seat_questions SET answered_at = ? WHERE run_id = ? AND answered_at IS NULL${
          unpassedOnly ? " AND passed_at IS NULL" : ""
        }`,
      ).run(at, runId);
    },

    closeQuestion(c: QuestionClosure): boolean {
      let stored = false;
      transaction(() => {
        stored = insertClosure(c);
      });
      return stored;
    },

    questionClosure(key: string, askAt: number): QuestionClosure | null {
      const r = db
        .prepare("SELECT * FROM question_closures WHERE key = ? AND ask_at = ?")
        .get(key, askAt) as Row | undefined;
      return r ? closureOf(r) : null;
    },

    closedItemKeys(): Map<string, QuestionClosure[]> {
      const rows = db
        .prepare(
          "SELECT * FROM question_closures WHERE key NOT LIKE 'ask:%' ORDER BY at DESC, rowid DESC",
        )
        .all() as Row[];
      const byKey = new Map<string, QuestionClosure[]>();
      for (const r of rows) {
        const c = closureOf(r);
        byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
      }
      return byKey;
    },

    questionClosures(since: number, limit: number): QuestionClosure[] {
      const rows = db
        .prepare(
          "SELECT * FROM question_closures WHERE operator = 1 AND at >= ? ORDER BY at DESC, rowid DESC LIMIT ?",
        )
        .all(since, limit) as Row[];
      return rows.map(closureOf);
    },

    /** The still-open questions of one run or seat, for the caller that closes them. */
    openQuestionsOf(where: "run_id" | "agent_id", id: string): SeatQuestion[] {
      const rows = db
        // a question the operator set aside outlives its run: it is answered on the Ticket page
        .prepare(
          `SELECT * FROM seat_questions WHERE ${where} = ? AND answered_at IS NULL AND aside_at IS NULL`,
        )
        .all(id) as Row[];
      return rows.map(toQuestion);
    },
  };
}
