import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  AUDIT_MEASURED_TOOLS,
  AUDIT_THRESHOLD_DEFAULTS,
  AUDIT_TICKET_TEXT_FLOOR,
  type AuditImprovement,
  type AuditThresholds,
  COMMS_CONTROLLER,
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

  /**
   * The ticket and PR a message is about: its own, else its sending run's ticket (or `fallback`),
   * else the ticket or PR its reference names.
   */
  const commsLink = (
    id: number,
    fallback: string | null = null,
  ): { ticket: string | null; pr: number | null } => {
    const m = all(
      `SELECT c.ticket, c.pr, c.ref, r.ticket AS run_ticket FROM comms c
       LEFT JOIN runs r ON r.id = c.from_run_id WHERE c.id = ?`,
      id,
    )[0];
    if (m === undefined) return { ticket: fallback, pr: null };
    const ref = (m.ref as string | null) ?? "";
    const refPr = /^PR (\d+)$/.exec(ref);
    return {
      ticket:
        (m.ticket as string | null) ??
        (m.run_ticket as string | null) ??
        fallback ??
        (/^#\d+$/.test(ref) ? ref : null),
      pr: (m.pr as number | null) ?? (refPr === null ? null : Number(refPr[1])),
    };
  };

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
  // A seat's question waited past the limit: counted when it is answered in range, or while it
  // is still open at the range end (its row is dated by the answer, or by the limit passing).
  for (const r of all(
    `SELECT q.id, q.at, q.answered_at, r.ticket AS ticket FROM seat_questions q
     LEFT JOIN runs r ON r.id = q.run_id
     WHERE (q.answered_at >= ? AND q.answered_at <= ? AND q.answered_at - q.at > ?)
        OR ((q.answered_at IS NULL OR q.answered_at > ?) AND q.at <= ? AND ? - q.at > ?)
     ORDER BY q.id`,
    since,
    until,
    t.questionWaitMs,
    until,
    until,
    until,
    t.questionWaitMs,
  )) {
    const answeredAt = r.answered_at as number | null;
    const open = answeredAt === null || answeredAt > until;
    const waited = open ? until - (r.at as number) : answeredAt - (r.at as number);
    out.push({
      kind: "question-waited",
      subject: `ask:${r.id as number}`,
      ticket: (r.ticket as string | null) ?? null,
      pr: null,
      detail: `A seat's question waited ${minutes(waited)}${open ? " and is still open" : ""} (limit ${minutes(t.questionWaitMs)}).`,
      at: open ? (r.at as number) + t.questionWaitMs : (answeredAt as number),
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
      ...commsLink(r.id as number, (r.r_ticket as string | null) ?? null),
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
    `SELECT p.message_id, COUNT(*) AS n, MAX(p.at) AS at FROM comms_repeats p
     WHERE p.at >= ? AND p.at <= ? GROUP BY p.message_id ORDER BY p.message_id`,
    since,
    until,
  )) {
    out.push({
      kind: "repeat-message",
      subject: `comms:${r.message_id as number}`,
      ...commsLink(r.message_id as number),
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

  // A request for the controller that waited too long. A reply, a "done" or a settlement closes
  // it. Counted when closed in range, or while still open at the range end.
  for (const r of all(
    `SELECT c.id, c.at, MIN(x.closed) AS closed FROM comms c
     LEFT JOIN (
       SELECT reply_to AS message_id, at AS closed FROM comms WHERE from_id = ? AND reply_to IS NOT NULL
       UNION ALL SELECT message_id, at FROM comms_reactions WHERE actor_id = ? AND reaction = 'done'
       UNION ALL SELECT message_id, at FROM comms_settlements
     ) x ON x.message_id = c.id
     WHERE c.to_id = ? AND c.from_id != ? AND c.at <= ?
     GROUP BY c.id
     HAVING (MIN(x.closed) >= ? AND MIN(x.closed) <= ? AND MIN(x.closed) - c.at > ?)
        OR ((MIN(x.closed) IS NULL OR MIN(x.closed) > ?) AND ? - c.at > ?)
     ORDER BY c.id`,
    COMMS_CONTROLLER,
    COMMS_CONTROLLER,
    COMMS_CONTROLLER,
    COMMS_CONTROLLER,
    until,
    since,
    until,
    t.controllerWaitMs,
    until,
    until,
    t.controllerWaitMs,
  )) {
    const closed = r.closed as number | null;
    const open = closed === null || closed > until;
    const waited = open ? until - (r.at as number) : closed - (r.at as number);
    out.push({
      kind: "controller-request-waited",
      subject: `comms:${r.id as number}`,
      ...commsLink(r.id as number),
      detail: `A request for the controller waited ${minutes(waited)}${open ? " and is still open" : ""} (limit ${minutes(t.controllerWaitMs)}).`,
      at: open ? (r.at as number) + t.controllerWaitMs : (closed as number),
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
  // Every row must link to a ticket or a PR; one that cannot be traced to either is left out.
  return out.filter((r) => r.ticket !== null || r.pr !== null);
}

/** The four measured report tools: calls and characters (sent plus returned) for the 24 hours up to `until`. */
export function toolImprovements(
  usage: ReadonlyMap<string, { calls: number; chars: number }>,
  until: number,
): AuditImprovement[] {
  return AUDIT_MEASURED_TOOLS.map((name) => {
    const u = usage.get(name) ?? { calls: 0, chars: 0 };
    return {
      kind: "tool-usage" as const,
      subject: name,
      ticket: null,
      pr: null,
      detail: `${name}: ${u.calls} calls and ${u.chars} characters in the last 24 hours.`,
      at: until,
      calls: u.calls,
      chars: u.chars,
    };
  });
}
