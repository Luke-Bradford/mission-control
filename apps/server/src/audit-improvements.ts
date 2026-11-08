import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  AUDIT_MEASURED_TOOLS,
  AUDIT_THRESHOLD_DEFAULTS,
  AUDIT_TICKET_TEXT_FLOOR,
  AUDIT_TOOL_WINDOW_MS,
  type AuditImprovement,
  type AuditThresholds,
  COMMS_CONTROLLER,
  type RunTokenAudit,
} from "@mc/core";

type Row = Record<string, unknown>;

/** The thresholds with any the config leaves out taken from the defaults. */
export function auditThresholds(set?: Partial<AuditThresholds>): AuditThresholds {
  return { ...AUDIT_THRESHOLD_DEFAULTS, ...set };
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Message problems for Audit's list of things to improve, from the hub's own records, in range.
 * `chatter` is the pairs past the round limit (`Store.commsChatter`). No model reads a message.
 */
export function messageImprovements(
  db: DatabaseSync,
  since: number,
  until: number,
  t: AuditThresholds,
  chatter: { from: string; to: string; ticket: string; rounds: number }[],
): AuditImprovement[] {
  const all = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as Row[];
  const out: AuditImprovement[] = [];

  /** The ticket a question key belongs to: a seat's ask by its run, any other by its choice or closure. */
  const ticketOf = (key: string): string | null => {
    const ask = /^ask:(\d+)$/.exec(key);
    if (ask !== null) {
      const r = all(
        "SELECT r.ticket AS ticket FROM seat_questions q JOIN runs r ON r.id = q.run_id WHERE q.id = ?",
        Number(ask[1]),
      )[0];
      return (r?.ticket as string | null | undefined) ?? null;
    }
    const c = all(
      `SELECT ticket FROM question_choices WHERE key = ? AND ticket IS NOT NULL
       UNION ALL SELECT ticket FROM question_closures WHERE key = ? AND ticket IS NOT NULL LIMIT 1`,
      key,
      key,
    )[0];
    return (c?.ticket as string | undefined) ?? null;
  };

  // The operator's first reply to a question was a question.
  for (const d of all("SELECT item_key, messages FROM item_discussions")) {
    const first = (JSON.parse(d.messages as string) as { role: string; text: string; at: number }[])
      .filter((m) => m.role === "operator")
      .sort((a, b) => a.at - b.at)[0];
    if (first === undefined || first.at < since || first.at > until) continue;
    if (!first.text.trim().endsWith("?")) continue;
    const key = d.item_key as string;
    out.push({
      kind: "question-asked-back",
      subject: key,
      ticket: ticketOf(key),
      pr: null,
      detail:
        "The operator's first reply to this question was a question; its background fell short.",
      at: first.at,
    });
  }

  // A question that waited longer than the set time (operator questions and seats' asks).
  for (const r of all(
    `SELECT key, brief_at, chosen_at, ticket FROM question_choices
     WHERE key NOT LIKE 'ask:%' AND chosen_at >= ? AND chosen_at <= ? AND chosen_at - brief_at > ?`,
    since,
    until,
    t.questionWaitMs,
  )) {
    out.push({
      kind: "question-waited",
      subject: `${r.key as string}@${r.brief_at as number}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: null,
      detail: `A question waited ${minutes((r.chosen_at as number) - (r.brief_at as number))} for an answer (limit ${minutes(t.questionWaitMs)}).`,
      at: r.chosen_at as number,
    });
  }
  for (const r of all(
    `SELECT key, ask_at, at, ticket FROM question_closures
     WHERE operator = 1 AND key NOT LIKE 'ask:%' AND at >= ? AND at <= ? AND at - ask_at > ?`,
    since,
    until,
    t.questionWaitMs,
  )) {
    out.push({
      kind: "question-waited",
      subject: `${r.key as string}@${r.ask_at as number}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: null,
      detail: `A question waited ${minutes((r.at as number) - (r.ask_at as number))} before it was closed (limit ${minutes(t.questionWaitMs)}).`,
      at: r.at as number,
    });
  }
  for (const r of all(
    `SELECT q.id, q.at, q.answered_at, r.ticket AS ticket FROM seat_questions q
     LEFT JOIN runs r ON r.id = q.run_id
     WHERE q.at >= ? AND q.at <= ? AND COALESCE(q.answered_at, ?) - q.at > ?`,
    since,
    until,
    until,
    t.questionWaitMs,
  )) {
    const waited = ((r.answered_at as number | null) ?? until) - (r.at as number);
    out.push({
      kind: "question-waited",
      subject: `ask:${r.id as number}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: null,
      detail: `A seat's question waited ${minutes(waited)}${r.answered_at == null ? " and is still open" : ""} (limit ${minutes(t.questionWaitMs)}).`,
      at: r.at as number,
    });
  }

  // A reply or answer delivered after the run it was meant for had ended.
  for (const r of all(
    `SELECT c.id, c.ticket AS c_ticket, c.pr, c.delivered_at, r.ticket AS r_ticket FROM comms c
     JOIN runs r ON r.id = c.target_run_id
     WHERE c.delivered_at >= ? AND c.delivered_at <= ? AND r.ended_at IS NOT NULL
       AND c.delivered_at > r.ended_at`,
    since,
    until,
  )) {
    out.push({
      kind: "delivered-after-run-ended",
      subject: `comms:${r.id as number}`,
      ticket: ((r.c_ticket ?? r.r_ticket) as string | null) ?? null,
      pr: (r.pr as number | null) ?? null,
      detail: "A message for a run was delivered after that run had ended.",
      at: r.delivered_at as number,
    });
  }

  // Two agents past the round limit on one ticket.
  for (const c of chatter) {
    out.push({
      kind: "chatter",
      subject: `${c.from}:${c.to}:${c.ticket}`,
      ticket: c.ticket,
      pr: null,
      detail: `${c.from} and ${c.to} went ${c.rounds} rounds on one ticket.`,
      at: until,
    });
  }

  // The same message sent more than once (the exact-repeat guard's count).
  for (const r of all(
    `SELECT p.message_id, COUNT(*) AS n, MAX(p.at) AS at, c.ticket, c.pr FROM comms_repeats p
     LEFT JOIN comms c ON c.id = p.message_id
     WHERE p.at >= ? AND p.at <= ? GROUP BY p.message_id ORDER BY p.message_id`,
    since,
    until,
  )) {
    out.push({
      kind: "repeat-message",
      subject: `comms:${r.message_id as number}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: (r.pr as number | null) ?? null,
      detail: `The same message was sent ${(r.n as number) + 1} times; the hub stored it once.`,
      at: r.at as number,
    });
  }

  // The same hub notice repeated on one PR.
  for (const r of all(
    `SELECT pr, text, COUNT(*) AS n, MAX(at) AS at, MAX(ticket) AS ticket FROM comms
     WHERE sender_kind = 'hub' AND pr IS NOT NULL AND at >= ? AND at <= ?
     GROUP BY pr, text HAVING COUNT(*) >= ? ORDER BY pr, text`,
    since,
    until,
    t.noticeRepeats,
  )) {
    out.push({
      kind: "repeat-notice",
      subject: `PR ${r.pr as number}: ${(r.text as string).slice(0, 80)}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: r.pr as number,
      detail: `The same notice was sent ${r.n as number} times on this PR.`,
      at: r.at as number,
    });
  }

  // A request for the controller that waited too long. A reply, a "done" or a settlement closes it.
  for (const r of all(
    `SELECT c.id, c.ticket, c.pr, c.at,
       MIN(x.closed) AS closed FROM comms c
     LEFT JOIN (
       SELECT reply_to AS message_id, at AS closed FROM comms WHERE from_id = ? AND reply_to IS NOT NULL
       UNION ALL SELECT message_id, at FROM comms_reactions WHERE actor_id = ? AND reaction = 'done'
       UNION ALL SELECT message_id, at FROM comms_settlements
     ) x ON x.message_id = c.id
     WHERE c.to_id = ? AND c.from_id != ? AND c.at >= ? AND c.at <= ?
     GROUP BY c.id HAVING COALESCE(MIN(x.closed), ?) - c.at > ? ORDER BY c.id`,
    COMMS_CONTROLLER,
    COMMS_CONTROLLER,
    COMMS_CONTROLLER,
    COMMS_CONTROLLER,
    since,
    until,
    until,
    t.controllerWaitMs,
  )) {
    const waited = ((r.closed as number | null) ?? until) - (r.at as number);
    out.push({
      kind: "controller-request-waited",
      subject: `comms:${r.id as number}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: (r.pr as number | null) ?? null,
      detail: `A request for the controller waited ${minutes(waited)}${r.closed == null ? " and is still open" : ""} (limit ${minutes(t.controllerWaitMs)}).`,
      at: r.at as number,
    });
  }

  // A ticket with far more message text than the usual ticket.
  const volumes = all(
    `SELECT ticket, SUM(length(text)) AS chars, MAX(at) AS at FROM comms
     WHERE ticket IS NOT NULL AND at >= ? AND at <= ? GROUP BY ticket ORDER BY ticket`,
    since,
    until,
  );
  if (volumes.length > 0) {
    const usual = median(volumes.map((v) => v.chars as number));
    for (const v of volumes) {
      const chars = v.chars as number;
      if (chars < AUDIT_TICKET_TEXT_FLOOR || chars < usual * t.ticketTextFactor) continue;
      out.push({
        kind: "ticket-message-volume",
        subject: v.ticket as string,
        ticket: v.ticket as string,
        pr: null,
        detail: `${chars} characters of messages; the usual ticket has ${Math.round(usual)}.`,
        at: v.at as number,
        chars,
      });
    }
  }
  return out;
}

/** The four measured report tools: calls and characters (written plus returned) for the 24 hours up to `until`. */
export function toolImprovements(
  audits: { startedAt: number; audit: RunTokenAudit }[],
  until: number,
): AuditImprovement[] {
  const from = until - AUDIT_TOOL_WINDOW_MS;
  return AUDIT_MEASURED_TOOLS.map(({ name, transcript }) => {
    let calls = 0;
    let written = 0;
    let returned = 0;
    for (const a of audits) {
      if (a.startedAt < from || a.startedAt > until) continue;
      const u = a.audit.byTool?.[transcript];
      if (u === undefined) continue;
      calls += u.calls;
      written += u.written;
      returned += u.returned;
    }
    return {
      kind: "tool-usage" as const,
      subject: name,
      ticket: null,
      pr: null,
      detail: `${name}: ${calls} calls in the last 24 hours, ${written} characters written and ${returned} returned.`,
      at: until,
      calls,
      chars: written + returned,
    };
  });
}
