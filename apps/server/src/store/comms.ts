import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import {
  CHATTER_NOTE_PREFIX,
  COMMS_CAPCOM,
  COMMS_CHATTER_ROUNDS,
  COMMS_CHATTER_WINDOW_MS,
  COMMS_CONTROLLER,
  COMMS_CREW,
  COMMS_MC,
  COMMS_NOTICE,
  COMMS_TEXT_MAX,
  type CommsKind,
  type CommsLabel,
  type CommsReaction,
  type CommsReactionKind,
  type CommsSenderKind,
  commsCutMarker,
  type Run,
  type TokenUsage,
} from "@mc/core";
import { parseJson } from "../json.ts";
import { toRun } from "./rows.ts";
import {
  type CommsLinkCount,
  type CommsReadScope,
  type CommsRow,
  type CommsSettlement,
  commsMessageNumber,
  commsPosition,
  LIVE_COMMS_LIMIT,
  type NewCommsRow,
  type NoteInput,
  THREAD_COMMS_LIMIT,
} from "./types.ts";

/** What the Comms queries borrow from the Store: its prepared-statement cache and shared writes. */
export interface CommsHost {
  transaction(fn: () => void, writeLock?: boolean): void;
  statement(sql: string): StatementSync;
  run(id: string): Run | null;
  raiseNote(n: NoteInput): void;
}

type Row = Record<string, SQLInputValue>;

/** How much of a link's newest message `commsLinkCounts` returns (the graph's hover preview). */
const COMMS_LINK_PREVIEW = 200;

export function cutCommsText(text: string): string {
  const chars = Array.from(text);
  return chars.length > COMMS_TEXT_MAX
    ? `${chars.slice(0, COMMS_TEXT_MAX).join("")}${commsCutMarker(COMMS_TEXT_MAX, chars.length)}`
    : text;
}

/** The queries over the comms and comms_reads tables (and the tables they join). */
export class CommsQueries {
  private readonly db: DatabaseSync;
  private readonly host: CommsHost;

  constructor(db: DatabaseSync, host: CommsHost) {
    this.db = db;
    this.host = host;
  }

  /**
   * The newest `limit` comms messages that name the ticket: by its qualified `repo#n` (set by the
   * hub), by the short `#n` a seat's or the operator's message carries, or by `PR n` for one of its
   * PRs. Short forms carry no repo, so the caller keeps only those that belong to this one.
   */
  commsOnTicket(
    ticket: string,
    shortRef: string,
    prRefs: readonly string[],
    limit: number,
  ): CommsRow[] {
    const marks = prRefs.map((_, i) => `?${i + 4}`).join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM comms WHERE ticket = ?1 OR ticket = ?2 OR ref = ?2 OR ref = ?1
           ${prRefs.length > 0 ? `OR ticket IN (${marks}) OR ref IN (${marks})` : ""}
         ORDER BY at DESC, id DESC LIMIT ?3`,
      )
      .all(ticket, shortRef, limit, ...prRefs) as Row[];
    return this.commsRows(rows);
  }

  /** Counts retained and retired reference metadata; never reads text or limits by time. */
  commsTicketReferenceCounts(): {
    ticket: string | null;
    ref: string | null;
    from: string;
    count: number;
  }[] {
    return (
      this.host
        .statement(`SELECT ticket, ref, sender, SUM(count) AS count FROM (
        SELECT ticket, ref, from_id AS sender, COUNT(*) AS count
        FROM comms WHERE ticket IS NOT NULL OR ref IS NOT NULL
        GROUP BY ticket, ref, from_id
        UNION ALL
        SELECT CASE WHEN ticket_null THEN NULL ELSE ticket END,
          CASE WHEN ref_null THEN NULL ELSE ref END, from_id AS sender, count
        FROM comms_ticket_archived_counts
      ) GROUP BY ticket, ref, sender`)
        .all() as Row[]
    ).map((r) => ({
      ticket: r.ticket as string | null,
      ref: r.ref as string | null,
      from: r.sender as string,
      count: r.count as number,
    }));
  }

  /** Records a hand-off whole up to COMMS_TEXT_MAX, then marks the stored copy's cut. */
  addComms(
    row: NewCommsRow,
    rate?: { since: number; limit: number },
    /** An identical message stored at or after this time is returned, flagged, not stored again. */
    repeatSince?: number,
    /** Server-resolved title for one internal context line accompanying an operator item send. */
    flightContextTitle?: string,
  ): (CommsRow & { repeat?: true }) | null {
    if (!Number.isFinite(row.at)) throw new Error("Comms messages need a time.");
    const label = row.label ?? "none";
    const text = cutCommsText(row.text);
    const replyTo =
      row.replyTo === undefined || row.replyTo === null ? null : commsMessageNumber(row.replyTo);
    if (row.replyTo !== undefined && row.replyTo !== null && replyTo === null)
      throw new Error("Invalid Comms message ID.");
    let id: number | null = null;
    let repeat = false;
    this.host.transaction(() => {
      if (repeatSince !== undefined) {
        const same = this.db
          .prepare(
            `SELECT id FROM comms WHERE from_id = ? AND to_id = ? AND text = ? AND at >= ?
               AND ticket IS ? AND label IS ? AND reply_to IS ? AND target_run_id IS ? AND item_key IS ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(
            row.from,
            row.to,
            text,
            repeatSince,
            row.ticket,
            label,
            replyTo,
            row.targetRunId ?? null,
            row.itemKey ?? null,
          ) as { id: number } | undefined;
        if (same !== undefined) {
          id = same.id;
          repeat = true;
          return;
        }
      }
      if (rate !== undefined) {
        const count = this.db
          .prepare("SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND at >= ?")
          .get(row.from, rate.since) as { n: number };
        if (count.n >= rate.limit) return;
      }
      id = this.insertComms({ ...row, label }, text, replyTo);
      if (
        row.from === COMMS_CAPCOM &&
        row.itemKey !== undefined &&
        flightContextTitle !== undefined
      ) {
        const context: NewCommsRow = {
          from: COMMS_MC,
          to: row.to,
          senderKind: "hub",
          at: row.at,
          ticket: row.ticket,
          text: `[Mission Control] Needs-you context ${JSON.stringify({
            messageId: `comms:${id}`,
            itemKey: row.itemKey,
            title: flightContextTitle,
          })}`,
        };
        this.insertComms(context, cutCommsText(context.text), null);
      }
      this.raiseChatterNote(row);
    }, true);
    const stored = id === null ? null : this.commsMessage(`comms:${id}`);
    return stored !== null && repeat ? { ...stored, repeat: true } : stored;
  }

  /** Opens one durable FLIGHT-facing note when a pair first crosses the rolling chatter limit. */
  private raiseChatterNote(row: NewCommsRow): void {
    if (
      row.ticket === null ||
      row.to === COMMS_CAPCOM ||
      row.to === COMMS_CREW ||
      row.to === COMMS_MC ||
      row.from === COMMS_CAPCOM ||
      row.from === COMMS_CREW ||
      row.from === COMMS_MC ||
      row.from === COMMS_CONTROLLER ||
      row.from === row.to
    )
      return;
    const pair = row.from < row.to ? [row.from, row.to] : [row.to, row.from];
    const crossed = this.commsChatter(row.at - COMMS_CHATTER_WINDOW_MS, row.at).some(
      (item) => item.ticket === row.ticket && item.from === pair[0] && item.to === pair[1],
    );
    if (!crossed) return;
    this.host.raiseNote({
      key: `${CHATTER_NOTE_PREFIX}${row.ticket}:${pair[0]}:${pair[1]}`,
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: row.ticket.slice(0, row.ticket.lastIndexOf("#")),
      text: `${pair[0]} and ${pair[1]} exceeded ${COMMS_CHATTER_ROUNDS} rounds on ${row.ticket}.`,
      at: row.at,
    });
  }

  insertComms(row: NewCommsRow, text: string, replyTo: number | null): number {
    // The sender's name must match its kind: CAPCOM is only ever the operator, and the hub is MC.
    if (row.from === COMMS_CAPCOM && row.senderKind !== undefined && row.senderKind !== "operator")
      throw new Error("Only the operator sends as CAPCOM.");
    if (row.senderKind === "hub" && row.from !== COMMS_MC)
      throw new Error("A hub message is sent as MC.");
    const inserted = this.db
      .prepare(
        "INSERT INTO comms (at, from_id, to_id, ticket, text, label, ref, reply_to, target_run_id, from_run_id, pr, sender_kind, kind, item_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.at,
        row.from,
        row.to,
        row.ticket,
        text,
        row.label ?? null,
        row.ref ?? null,
        replyTo,
        row.targetRunId ?? null,
        row.fromRunId ?? null,
        row.pr ?? null,
        row.senderKind ?? null,
        row.kind ?? (row.senderKind === "hub" ? COMMS_NOTICE : null),
        row.itemKey ?? null,
      );
    const id = Number(inserted.lastInsertRowid);
    const mention = this.db.prepare(
      "INSERT OR IGNORE INTO comms_mentions (message_id, mentioned_id) VALUES (?, ?)",
    );
    for (const target of row.mentions ?? []) mention.run(id, target);
    return id;
  }

  private commsRow(r: Row, knownMentions?: string[]): CommsRow {
    const id = Number(r.id);
    const mentions =
      knownMentions ??
      this.db
        .prepare(
          "SELECT mentioned_id FROM comms_mentions WHERE message_id = ? ORDER BY mentioned_id",
        )
        .all(id)
        .map((m) => m.mentioned_id as string);
    return {
      id: `comms:${id}`,
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
      label: r.label as CommsLabel | null,
      ref: r.ref as string | null,
      replyTo: r.reply_to == null ? null : `comms:${r.reply_to}`,
      mentions,
      deliveredAt: (r.delivered_at as number | null | undefined) ?? null,
      senderKind: (r.sender_kind as CommsSenderKind | null) ?? null,
      kind: (r.kind as CommsKind | null) ?? null,
      ...(typeof r.item_key === "string" ? { itemKey: r.item_key } : {}),
    };
  }

  /** Bound mention reads per snapshot; retain no message or mention cache between calls. */
  private commsRows(rows: Row[]): CommsRow[] {
    const mentions = new Map<number, string[]>();
    // Stay below even SQLite's older 999-variable limit if the snapshot limit grows.
    const batchSize = 400;
    for (let start = 0; start < rows.length; start += batchSize) {
      const ids = rows.slice(start, start + batchSize).map((row) => Number(row.id));
      const found = this.db
        .prepare(
          `SELECT message_id, mentioned_id FROM comms_mentions WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id, mentioned_id`,
        )
        .all(...ids);
      for (const row of found) {
        const id = Number(row.message_id);
        const names = mentions.get(id) ?? [];
        names.push(row.mentioned_id as string);
        mentions.set(id, names);
      }
    }
    return rows.map((row) => this.commsRow(row, mentions.get(Number(row.id))?.slice() ?? []));
  }

  /** Records that the recipient took a message; the first time wins. */
  markCommsDelivered(id: string, at: number): void {
    const n = commsMessageNumber(id);
    if (n !== null)
      this.db
        .prepare("UPDATE comms SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
        .run(at, n);
  }

  markCommsWakeFailed(id: string, at: number): void {
    const n = commsMessageNumber(id);
    if (n !== null) this.db.prepare("UPDATE comms SET wake_failed_at = ? WHERE id = ?").run(at, n);
  }

  clearCommsWakeFailed(id: string): void {
    const n = commsMessageNumber(id);
    if (n !== null) this.db.prepare("UPDATE comms SET wake_failed_at = NULL WHERE id = ?").run(n);
  }

  commsWakeFailed(id: string): boolean {
    const n = commsMessageNumber(id);
    return (
      n !== null &&
      this.db.prepare("SELECT wake_failed_at FROM comms WHERE id = ?").get(n)?.wake_failed_at !=
        null
    );
  }

  /** The run and PR the hub stamped on a message; nulls for a message it did not stamp. */
  commsStamp(id: string): { runId: string | null; pr: number | null } {
    const n = commsMessageNumber(id);
    const r =
      n === null
        ? undefined
        : (this.db.prepare("SELECT from_run_id, pr FROM comms WHERE id = ?").get(n) as
            | Row
            | undefined);
    return {
      runId: (r?.from_run_id as string | null | undefined) ?? null,
      pr: (r?.pr as number | null | undefined) ?? null,
    };
  }

  commsMessage(id: string): CommsRow | null {
    const n = commsMessageNumber(id);
    if (n === null) return null;
    return this.commsMessageByNumber(n);
  }

  /** Fixed delivery target, otherwise the sender's run that was open when it wrote the line. */
  commsRun(id: string, inferSender = true): Run | null {
    const number = commsMessageNumber(id);
    if (number === null) return null;
    const source = this.host
      .statement("SELECT target_run_id, from_id, at FROM comms WHERE id = ?")
      .get(number) as Row | undefined;
    if (!source) return null;
    if (source.target_run_id !== null) return this.host.run(source.target_run_id as string);
    if (!inferSender) return null;
    const row = this.host
      .statement(`SELECT * FROM runs WHERE agent_id = ? AND started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC, seq DESC, id DESC LIMIT 1`)
      .get(source.from_id as string, source.at as number, source.at as number) as Row | undefined;
    return row ? toRun(row) : null;
  }

  private commsMessageByNumber(id: number): CommsRow | null {
    const row = this.db.prepare("SELECT * FROM comms WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : this.commsRow(row);
  }

  addCommsReaction(
    messageId: string,
    actor: string,
    reaction: CommsReactionKind,
    reason: string | undefined,
    at: number,
  ): CommsReaction | null {
    const id = commsMessageNumber(messageId);
    if (id === null) return null;
    const message = this.commsMessageByNumber(id);
    if (message === null) return null;
    this.db
      .prepare(`INSERT INTO comms_reactions (message_id, actor_id, reaction, reason, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id, actor_id) DO UPDATE SET reaction=excluded.reaction, reason=excluded.reason, at=excluded.at`)
      .run(id, actor, reaction, reason ?? null, at);
    return { messageId: message.id, actor, reaction, reason: reason ?? null, at };
  }

  setCommsPinned(messageId: string, pinned: boolean, actor: string, at: number): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null) return false;
    const message = this.commsMessageByNumber(id);
    if (message === null) return false;
    if (pinned)
      this.db
        .prepare(
          "INSERT INTO comms_pins (message_id, pinned_by, pinned_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET pinned_by=excluded.pinned_by, pinned_at=excluded.pinned_at",
        )
        .run(id, actor, at);
    else this.db.prepare("DELETE FROM comms_pins WHERE message_id = ?").run(id);
    return true;
  }

  commsPins(): CommsRow[] {
    return this.commsRows(
      this.db
        .prepare(
          "SELECT c.* FROM comms c JOIN comms_pins p ON p.message_id=c.id ORDER BY p.pinned_at DESC",
        )
        .all() as Row[],
    );
  }

  commsReactions(messageId: string): CommsReaction[] {
    return this.commsReactionsFor([messageId]).get(messageId) ?? [];
  }

  /** The reactions on each message, read in batches of one query; a message with none is absent. */
  commsReactionsFor(messageIds: readonly string[]): Map<string, CommsReaction[]> {
    const found = new Map<string, CommsReaction[]>();
    const ids = [
      ...new Set(
        messageIds.flatMap((messageId) => {
          const id = commsMessageNumber(messageId);
          return id === null ? [] : [id];
        }),
      ),
    ];
    // Stay below even SQLite's older 999-variable limit.
    const batchSize = 400;
    for (let start = 0; start < ids.length; start += batchSize) {
      const batch = ids.slice(start, start + batchSize);
      const rows = this.db
        .prepare(
          `SELECT message_id, actor_id, reaction, reason, at FROM comms_reactions
           WHERE message_id IN (${batch.map(() => "?").join(",")}) ORDER BY message_id, at, actor_id`,
        )
        .all(...batch);
      for (const r of rows) {
        const key = `comms:${r.message_id}`;
        const list = found.get(key) ?? [];
        list.push({
          messageId: key,
          actor: r.actor_id as string,
          reaction: r.reaction as CommsReactionKind,
          reason: r.reason as string | null,
          at: r.at as number,
        });
        found.set(key, list);
      }
    }
    return found;
  }

  commsSettlement(messageId: string): CommsSettlement | null {
    const id = commsMessageNumber(messageId);
    if (id === null) return null;
    const row = this.db
      .prepare("SELECT settled_by, reason, at FROM comms_settlements WHERE message_id=?")
      .get(id) as Row | undefined;
    return row === undefined
      ? null
      : {
          messageId,
          settledBy: row.settled_by as string,
          reason: row.reason as string,
          at: row.at as number,
        };
  }

  settleCommsItem(messageId: string, settledBy: string, reason: string, at: number): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null || this.commsMessageByNumber(id) === null) return false;
    this.db
      .prepare(
        "INSERT INTO comms_settlements (message_id, settled_by, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING",
      )
      .run(id, settledBy, reason, at);
    return true;
  }

  commsMentions(target: string): CommsRow[] {
    return this.commsRows(
      this.db
        .prepare(
          "SELECT c.* FROM comms c JOIN comms_mentions m ON m.message_id=c.id WHERE m.mentioned_id=? ORDER BY c.at DESC,c.id DESC",
        )
        .all(target) as Row[],
    );
  }

  markCommsMentionsSeen(target: string, ids: string[], at: number): void {
    const q = this.db.prepare(
      "UPDATE comms_mentions SET seen_at=? WHERE mentioned_id=? AND message_id=?",
    );
    for (const id of ids) {
      const number = commsMessageNumber(id);
      if (number !== null) q.run(at, target, number);
    }
  }

  commsMentionSeen(target: string, id: string): boolean {
    const number = commsMessageNumber(id);
    if (number === null) return false;
    return (
      (
        this.db
          .prepare("SELECT seen_at FROM comms_mentions WHERE mentioned_id=? AND message_id=?")
          .get(target, number) as { seen_at: number | null } | undefined
      )?.seen_at !== null
    );
  }

  commsForCrew(): CommsRow[] {
    return this.commsForWhere("to_id = 'crew'");
  }

  /** Seat-side reads include only general Comms and rows targeted at its live run. */
  commsForCrewRun(runId: string): CommsRow[] {
    return this.commsForRunWhere(runId, "to_id = 'crew'");
  }

  commsForAgent(id: string, contact?: string): CommsRow[] {
    return contact === undefined
      ? this.commsForWhere("from_id=? OR to_id=?", id, id)
      : this.commsForPair(id, contact);
  }

  commsForAgentRun(id: string, runId: string): CommsRow[] {
    return this.commsForRunWhere(runId, "from_id=? OR to_id=?", id, id);
  }

  commsInbox(id: string): CommsRow[] {
    return this.commsForWhere(
      `id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        UNION
        SELECT message_id FROM comms_pins
      )`,
      id,
      id,
      id,
    );
  }

  commsInboxRun(id: string, runId: string): CommsRow[] {
    return this.commsForWhere(
      `(
        (target_run_id IS NULL OR target_run_id = ?)
        AND id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        )
      ) OR id IN (SELECT message_id FROM comms_pins)`,
      runId,
      id,
      id,
      id,
    );
  }

  commsForPair(a: string, b: string): CommsRow[] {
    return this.commsForWhere("(from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", a, b, b, a);
  }

  private flightConversationScope(
    flightId: string,
    seats: readonly string[],
    hideNotices = false,
  ): { sql: string; args: SQLInputValue[] } {
    const targets = [...new Set([flightId, ...seats])];
    // The hub's notices to FLIGHT belong to its conversation; its internal context rows do not.
    return {
      sql: `(((c.from_id = ? AND c.to_id = ?) OR (c.from_id = ? AND c.to_id = ?))
      OR (c.from_id = ? AND q.target IN (${targets.map(() => "?").join(",")}))
      OR (c.from_id = ? AND c.to_id = ? AND c.kind = ?))
      AND (c.sender_kind IS NOT 'hub' OR c.kind = ?)
      AND LTRIM(c.text, char(9) || char(10) || char(13) || ' ') NOT LIKE '[Mission Control]%'${
        hideNotices ? " AND c.kind IS NOT ?" : ""
      }`,
      args: [
        COMMS_CAPCOM,
        flightId,
        flightId,
        COMMS_CAPCOM,
        COMMS_CAPCOM,
        ...targets,
        COMMS_MC,
        flightId,
        COMMS_NOTICE,
        COMMS_NOTICE,
        ...(hideNotices ? [COMMS_NOTICE] : []),
      ],
    };
  }

  /** A choice is projected from its durable receipt, never inferred from its rendered text. */
  flightConversationStored(
    flightId: string,
    seats: readonly string[],
    limit: number,
    before?: { at: number; id: number },
    exactId?: string,
    hideNotices = false,
  ): (CommsRow & { choice?: { label: string } })[] {
    const scope = this.flightConversationScope(flightId, seats, hideNotices);
    const id = exactId === undefined ? null : commsMessageNumber(exactId);
    if (exactId !== undefined && id === null) return [];
    const rows = this.db
      .prepare(`SELECT c.*, q.key AS choice_key, q.label AS choice_label FROM comms c
      LEFT JOIN question_choices q ON q.rowid = (SELECT rowid FROM question_choices x WHERE x.message_id = c.id ORDER BY x.chosen_at DESC, x.key, x.brief_at DESC LIMIT 1)
      WHERE ${scope.sql}${id === null ? "" : " AND c.id = ?"}${before ? " AND (c.at, c.id) < (?, ?)" : ""}
      ORDER BY c.at DESC, c.id DESC LIMIT ?`)
      .all(
        ...scope.args,
        ...(id === null ? [] : [id]),
        ...(before ? [before.at, before.id] : []),
        limit,
      ) as Row[];
    const ordered = rows.reverse();
    const base = this.commsRows(ordered);
    return ordered.map((r, i) => ({
      ...(base[i] as CommsRow),
      ...(typeof r.choice_label === "string"
        ? { choice: { label: r.choice_label }, itemKey: (r.item_key ?? r.choice_key) as string }
        : {}),
    }));
  }

  latestFlightStoredReplyAt(flightId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(at) AS at FROM comms WHERE from_id = ? AND to_id = ? AND sender_kind IS NOT 'hub'
      AND LTRIM(text, char(9) || char(10) || char(13) || ' ') NOT LIKE '[Mission Control]%'`)
      .get(flightId, COMMS_CAPCOM) as Row;
    return row.at as number | null;
  }

  /** When FLIGHT sent the operator a message of its own (not a hub notice), oldest first. */
  flightOperatorMessageTimes(flightId: string): number[] {
    const rows = this.db
      .prepare(`SELECT at FROM comms WHERE from_id = ? AND to_id = ? AND sender_kind IS NOT 'hub'
      AND LTRIM(text, char(9) || char(10) || char(13) || ' ') NOT LIKE '[Mission Control]%'
      ORDER BY at`)
      .all(flightId, COMMS_CAPCOM) as Row[];
    return rows.map((r) => r.at as number);
  }

  flightConversationUnread(
    flightId: string,
    seats: readonly string[],
    cursor: string | null,
    bound?: { at: number; source: string; offset: number },
  ): number {
    const scope = this.flightConversationScope(flightId, seats);
    const after = bound
      ? bound.source === "comms"
        ? "(c.at, c.id) > (?, ?)"
        : "c.at > ?"
      : "c.id > ?";
    const args = bound
      ? bound.source === "comms"
        ? [bound.at, bound.offset]
        : [bound.at]
      : [cursor ? (commsMessageNumber(cursor) ?? 0) : 0];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM comms c
      LEFT JOIN question_choices q ON q.rowid = (SELECT rowid FROM question_choices x WHERE x.message_id = c.id ORDER BY x.chosen_at DESC, x.key, x.brief_at DESC LIMIT 1)
      WHERE ${scope.sql} AND c.kind IS NOT ? AND ${after}`)
      .get(...scope.args, COMMS_NOTICE, ...args) as Row;
    return row.n as number;
  }

  flightConversationStoredReadThrough(
    flightId: string,
    seats: readonly string[],
    bound: { at: number; source: string; offset: number },
  ): number | null {
    const scope = this.flightConversationScope(flightId, seats);
    const through = bound.source === "comms" ? "(c.at, c.id) <= (?, ?)" : "c.at <= ?";
    const row = this.db
      .prepare(`SELECT MAX(c.id) AS id FROM comms c
      LEFT JOIN question_choices q ON q.rowid = (SELECT rowid FROM question_choices x WHERE x.message_id = c.id ORDER BY x.chosen_at DESC, x.key, x.brief_at DESC LIMIT 1)
      WHERE ${scope.sql} AND ${through}`)
      .get(
        ...scope.args,
        ...[bound.at, ...(bound.source === "comms" ? [bound.offset] : [])],
      ) as Row;
    return row.id as number | null;
  }

  private commsScopeWhere(scope: CommsReadScope): { where: string; args: SQLInputValue[] } {
    if ("crew" in scope) return { where: "to_id = 'crew'", args: [] };
    if ("pair" in scope) {
      const [a, b] = scope.pair;
      return { where: "((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))", args: [a, b, b, a] };
    }
    if ("agent" in scope)
      return { where: "(from_id=? OR to_id=?)", args: [scope.agent, scope.agent] };
    const id = scope.inbox;
    return {
      where: `id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        UNION
        SELECT message_id FROM comms_pins
      )`,
      args: [id, id, id],
    };
  }

  /**
   * The newest `limit` messages of a scope, oldest first, strictly older than `before` when given.
   * `hasMore` says older ones remain, so the HUD can offer "load older".
   */
  commsPage(
    scope: CommsReadScope,
    limit: number,
    before?: string,
    recentSince?: number,
    hideNotices = false,
  ): { rows: CommsRow[]; hasMore: boolean } {
    const { where, args } = this.commsRecentScopeWhere(scope, recentSince, hideNotices);
    const beforeId = before === undefined ? null : commsMessageNumber(before);
    const rows = this.commsRows(
      this.db
        .prepare(
          `SELECT * FROM comms WHERE ${where}${
            beforeId === null ? "" : " AND (at, id) < (SELECT at, id FROM comms WHERE id = ?)"
          } ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(...args, ...(beforeId === null ? [] : [beforeId]), limit + 1) as Row[],
    );
    const hasMore = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), hasMore };
  }

  /** How many messages a scope holds, and how many of them come after the read cursor. */
  commsCounts(
    scope: CommsReadScope,
    cursor: string | null,
    recentSince?: number,
    hideNotices = false,
  ): { count: number; unread: number } {
    const { where, args } = this.commsRecentScopeWhere(scope, recentSince, hideNotices);
    const offset = cursor === null ? 0 : (commsMessageNumber(cursor) ?? 0);
    // a notice is never unread, shown or not
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(id > ? AND kind IS NOT ?), 0) AS unread
         FROM comms WHERE ${where}`,
      )
      .get(offset, COMMS_NOTICE, ...args) as { count: number; unread: number };
    return { count: r.count, unread: r.unread };
  }

  private commsRecentScopeWhere(scope: CommsReadScope, since?: number, hideNotices = false) {
    const scoped = this.commsScopeWhere(scope);
    const base = hideNotices
      ? { where: `(${scoped.where}) AND kind IS NOT ?`, args: [...scoped.args, COMMS_NOTICE] }
      : scoped;
    if (since === undefined) return base;
    return {
      where: `(${base.where}) AND at >= ? AND (
        (target_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM runs r WHERE r.id = comms.target_run_id AND r.ended_at IS NULL))
        OR (target_run_id IS NULL AND (NOT EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = comms.from_id)
        OR (SELECT r.ended_at IS NULL FROM runs r WHERE r.agent_id = comms.from_id AND
          r.started_at <= comms.at AND (r.ended_at IS NULL OR r.ended_at >= comms.at)
          ORDER BY r.started_at DESC, r.seq DESC, r.id DESC LIMIT 1) = 1))
      )`,
      args: [...base.args, since],
    };
  }

  /** Everyone `id` has exchanged messages with, in first-contact order. */
  commsContactIds(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS contact
          FROM comms WHERE from_id=? OR to_id=? GROUP BY contact ORDER BY MIN(id)`,
        )
        .all(id, id, id) as { contact: string }[]
    ).map((r) => r.contact);
  }

  commsForRefs(refs: string[]): CommsRow[] {
    if (!refs.length) return [];
    return this.commsForWhere(`ref IN (${refs.map(() => "?").join(",")})`, ...refs);
  }

  commsForTicket(
    ref: string,
    ticketContext?: string,
  ): {
    ref: string;
    linkedPr: string | null;
    repoId: string | null;
    rows: CommsRow[];
  } {
    const prNumber = ref.startsWith("PR ") ? Number(ref.slice(3)) : null;
    let issueNumber = ref.startsWith("#") ? Number(ref.slice(1)) : null;
    const qualified = ticketContext?.match(/^(.+)#(\d+)$/);
    // A #n link may only carry its own ticket. PR links keep their PR number and use the ticket
    // solely as repository context.
    const scopedTicket =
      qualified && (issueNumber === null || Number(qualified[2]) === issueNumber)
        ? ticketContext
        : undefined;
    const scopedRepoId = scopedTicket === undefined ? undefined : (qualified?.[1] as string);
    let linkedPr: string | null = null;
    let linkedRows: { number: number; repoId: string; ticket: string | null }[] = [];
    if (prNumber !== null) {
      linkedRows = this.db
        .prepare(
          `SELECT number, repo_id, ticket FROM pull_requests WHERE number=?${
            scopedRepoId === undefined ? "" : " AND repo_id=?"
          } ORDER BY updated_at DESC`,
        )
        .all(prNumber, ...(scopedRepoId === undefined ? [] : [scopedRepoId]))
        .map((row) => ({
          number: row.number as number,
          repoId: row.repo_id as string,
          ticket: row.ticket as string | null,
        }));
      const row = linkedRows[0];
      const match = row?.ticket?.match(/#(\d+)$/);
      issueNumber = match === null || match === undefined ? null : Number(match[1]);
      linkedPr = `PR ${prNumber}`;
    } else if (issueNumber !== null) {
      linkedRows = this.db
        .prepare(
          scopedRepoId === undefined
            ? "SELECT number, repo_id, ticket FROM pull_requests WHERE ticket GLOB ? ORDER BY updated_at DESC"
            : "SELECT number, repo_id, ticket FROM pull_requests WHERE ticket=? AND repo_id=? ORDER BY updated_at DESC",
        )
        .all(
          ...(scopedRepoId === undefined
            ? [`*#${issueNumber}`]
            : [scopedTicket as string, scopedRepoId]),
        )
        .map((row) => ({
          number: row.number as number,
          repoId: row.repo_id as string,
          ticket: row.ticket as string | null,
        }));
      linkedPr = linkedRows[0] === undefined ? null : `PR ${linkedRows[0].number}`;
    }
    const resolvedRef = issueNumber === null ? ref : `#${issueNumber}`;
    const refs = linkedPr === null ? [resolvedRef] : [resolvedRef, linkedPr];
    const predicates = [`ref IN (${refs.map(() => "?").join(",")})`, "text LIKE ?"];
    const args: SQLInputValue[] = [...refs, `%${resolvedRef}%`];
    if (linkedPr !== null) {
      predicates.push("text LIKE ?");
      args.push(`%${linkedPr}%`);
    }
    const ticketPredicate =
      scopedTicket === undefined
        ? ""
        : prNumber === null
          ? " AND ticket=?"
          : " AND substr(ticket, 1, length(?))=?";
    const ticketArgs: SQLInputValue[] =
      scopedTicket === undefined
        ? []
        : prNumber === null
          ? [scopedTicket]
          : [`${scopedRepoId}#`, `${scopedRepoId}#`];
    const rows = this.commsForWhere(
      `(${predicates.join(" OR ")})${ticketPredicate}`,
      ...args,
      ...ticketArgs,
    ).filter((row) => {
      if (refs.includes(row.ref ?? "")) return true;
      return refs.some((candidate) =>
        new RegExp(`(^|[^A-Za-z0-9])${candidate.replace("#", "\\#")}(?=$|[^A-Za-z0-9])`).test(
          row.text,
        ),
      );
    });
    const repoIds = new Set<string>();
    const repoFor = (ticket: string | null): string | null => {
      const match = ticket?.match(/^(.+)#(\d+)$/);
      return match?.[2] === String(issueNumber) ? (match[1] ?? null) : null;
    };
    // A clicked hub-set ticket is authoritative. Otherwise the linked PR's repo wins; without
    // either, only rows explicitly tagged with this ref count. A mere text mention never attributes.
    if (scopedRepoId !== undefined) repoIds.add(scopedRepoId);
    else for (const row of linkedRows) repoIds.add(row.repoId);
    if (repoIds.size === 0) {
      for (const row of rows) {
        if (!refs.includes(row.ref ?? "")) continue;
        const repoId = repoFor(row.ticket);
        if (repoId !== null) repoIds.add(repoId);
      }
    }
    return {
      ref: resolvedRef,
      linkedPr,
      repoId: repoIds.size === 1 ? [...repoIds][0] : null,
      rows,
    };
  }

  private commsForWhere(where: string, ...args: SQLInputValue[]): CommsRow[] {
    return this.commsRows(
      this.db.prepare(`SELECT * FROM comms WHERE ${where} ORDER BY at,id`).all(...args) as Row[],
    );
  }

  private commsForRunWhere(runId: string, where: string, ...args: SQLInputValue[]): CommsRow[] {
    return this.commsForWhere(
      `(${where}) AND (target_run_id IS NULL OR target_run_id = ?)`,
      ...args,
      runId,
    );
  }

  /**
   * Direct-link counts since `since`, each with its newest message (id, time and the first
   * COMMS_LINK_PREVIEW characters) so the Comms graph can show it and spot a new one.
   */
  commsLinkCounts(since: number, until = Date.now()): CommsLinkCount[] {
    const rows = this.db
      .prepare(
        `SELECT c.from_id AS 'from', c.to_id AS 'to', g.count AS count, c.id AS lastId,
          c.at AS lastAt, substr(c.text, 1, ?) AS lastText
        FROM (SELECT from_id, to_id, COUNT(*) AS count, MAX(id) AS last FROM comms WHERE at>=?
          GROUP BY from_id,to_id) g
        JOIN comms c ON c.id = g.last
        ORDER BY c.from_id, c.to_id`,
      )
      .all(COMMS_LINK_PREVIEW, since) as Row[];
    return rows.map((r) => ({
      from: r.from as string,
      to: r.to as string,
      count: r.count as number,
      lastId: `comms:${r.lastId as number}`,
      lastAt: r.lastAt as number,
      lastText: r.lastText as string,
      tokens: this.commsTokenTotal(r.from as string, r.to as string, null, since, until),
    }));
  }

  /** Hourly direct-link counts for the Comms Traffic chart. */
  commsHourlyLinkCounts(
    since: number,
  ): { hour: number; from: string; to: string; count: number }[] {
    return this.db
      .prepare(
        "SELECT (at / 3600000) * 3600000 AS hour, from_id AS 'from', to_id AS 'to', COUNT(*) AS count FROM comms WHERE at>=? GROUP BY hour, from_id, to_id ORDER BY hour, from_id, to_id",
      )
      .all(since) as { hour: number; from: string; to: string; count: number }[];
  }

  /** Back-and-forth pairs on one ticket; a round needs a message in each direction. */
  commsChatter(
    since: number,
    until = Number.MAX_SAFE_INTEGER,
    flightId?: string,
  ): {
    from: string;
    to: string;
    ticket: string;
    rounds: number;
    tokens: number;
    flightSteppedInAt: number | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT "from", "to", ticket, first_at, last_at,
          CASE WHEN forward_count < reverse_count THEN forward_count ELSE reverse_count END AS rounds
        FROM (
          SELECT CASE WHEN from_id < to_id THEN from_id ELSE to_id END AS 'from',
            CASE WHEN from_id < to_id THEN to_id ELSE from_id END AS 'to', ticket,
            SUM(CASE WHEN from_id < to_id THEN 1 ELSE 0 END) AS forward_count,
            SUM(CASE WHEN from_id > to_id THEN 1 ELSE 0 END) AS reverse_count,
            MIN(at) AS first_at, MAX(at) AS last_at
          FROM comms
          WHERE at >= ? AND at <= ? AND ticket IS NOT NULL
            AND from_id NOT IN (?, ?, ?) AND to_id NOT IN (?, ?, ?) AND from_id != to_id
          GROUP BY ticket, CASE WHEN from_id < to_id THEN from_id ELSE to_id END,
            CASE WHEN from_id < to_id THEN to_id ELSE from_id END
        )
        WHERE CASE WHEN forward_count < reverse_count THEN forward_count ELSE reverse_count END > ?
        ORDER BY rounds DESC, ticket, "from", "to"`,
      )
      .all(
        since,
        until,
        COMMS_CAPCOM,
        COMMS_MC,
        COMMS_CREW,
        COMMS_CAPCOM,
        COMMS_MC,
        COMMS_CREW,
        COMMS_CHATTER_ROUNDS,
      ) as Row[];
    return rows.map((row) => {
      const from = row.from as string;
      const to = row.to as string;
      const ticket = row.ticket as string;
      const thresholdAt = this.chatterThresholdAt(from, to, ticket, since, until);
      return {
        from,
        to,
        ticket,
        rounds: row.rounds as number,
        tokens: this.commsTokenTotal(
          from,
          to,
          ticket,
          row.first_at as number,
          row.last_at as number,
        ),
        flightSteppedInAt:
          flightId === undefined || thresholdAt === null
            ? null
            : ((
                this.db
                  .prepare(
                    "SELECT MIN(at) AS at FROM comms WHERE from_id = ? AND to_id IN (?, ?) AND ticket = ? AND at >= ? AND at <= ?",
                  )
                  .get(flightId, from, to, ticket, thresholdAt, until) as { at: number | null }
              ).at ?? null),
      };
    });
  }

  /** The message which first completes the over-limit reciprocal exchange in this rolling window. */
  private chatterThresholdAt(
    from: string,
    to: string,
    ticket: string,
    since: number,
    until: number,
  ): number | null {
    const messages = this.db
      .prepare(
        `SELECT at, from_id FROM comms WHERE ticket = ? AND at >= ? AND at <= ?
         AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) ORDER BY at, id`,
      )
      .all(ticket, since, until, from, to, to, from) as { at: number; from_id: string }[];
    let forward = 0;
    let reverse = 0;
    for (const message of messages) {
      if (message.from_id === from) forward++;
      else reverse++;
      if (Math.min(forward, reverse) > COMMS_CHATTER_ROUNDS) return message.at;
    }
    return null;
  }

  /** Tokens consumed by either end's runs overlapping a Comms link's observed window. */
  private commsTokenTotal(
    from: string,
    to: string,
    ticket: string | null,
    since: number,
    until: number,
  ): number {
    const rows = this.db
      .prepare(
        `SELECT tokens FROM runs WHERE agent_id IN (?, ?) AND started_at <= ?
         AND (ended_at IS NULL OR ended_at >= ?)${ticket === null ? "" : " AND ticket = ?"}`,
      )
      .all(
        ...(ticket === null ? [from, to, until, since] : [from, to, until, since, ticket]),
      ) as Row[];
    return rows.reduce((total, row) => {
      if (row.tokens === null) return total;
      const tokens = parseJson<TokenUsage | null>(row.tokens, null);
      if (tokens === null) return total;
      return total + tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    }, 0);
  }

  /**
   * One Needs-you item's conversation since `since` (the item's own raising: a note key is reused),
   * oldest first: the messages sent from it and every reply in it (a reply inherits its message's
   * item). The hub's own context lines and notices stay out; a picked option carries its label.
   */
  itemThread(itemKey: string, since = 0, limit = 100): (CommsRow & { choice?: string })[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT c.*, q.label AS choice_label FROM comms c
           LEFT JOIN question_choices q ON q.message_id = c.id
           WHERE c.item_key = ? AND c.at >= ? AND c.from_id != ? AND c.kind IS NULL
           ORDER BY c.at DESC, c.id DESC LIMIT ?
         ) ORDER BY at ASC, id ASC`,
      )
      .all(itemKey, since, COMMS_MC, limit) as Row[];
    const base = this.commsRows(rows);
    return rows.map((r, i) => ({
      ...(base[i] as CommsRow),
      ...(typeof r.choice_label === "string" ? { choice: r.choice_label } : {}),
    }));
  }

  /** Labelled direct questions and blockers still awaiting their addressee's reply or reaction. */
  openCommsItems(): (CommsRow & { label: "question" | "blocker" })[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM comms c
         WHERE c.label IN ('question', 'blocker') AND c.to_id != ?
           AND NOT EXISTS (
             SELECT 1 FROM comms_reactions r WHERE r.message_id = c.id AND r.actor_id = c.to_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM comms reply
             WHERE reply.reply_to = c.id AND reply.from_id = c.to_id
           )
           AND NOT EXISTS (SELECT 1 FROM comms_settlements s WHERE s.message_id = c.id)
         ORDER BY c.at ASC, c.id ASC`,
      )
      .all(COMMS_CREW) as Row[];
    return this.commsRows(rows) as (CommsRow & { label: "question" | "blocker" })[];
  }

  /** The newest `limit` messages with an id above `sinceId`, newest first; text cut to `textMax`. */
  commsFeed(
    sinceId: number,
    limit: number,
    textMax: number,
  ): Pick<CommsRow, "id" | "at" | "from" | "to" | "label" | "ref" | "text" | "senderKind">[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, from_id, to_id, label, ref, sender_kind, substr(text, 1, ?) AS text FROM comms
         WHERE id > ? ORDER BY id DESC LIMIT ?`,
      )
      .all(textMax, sinceId, limit) as Row[];
    return rows.map((r) => ({
      id: `comms:${Number(r.id)}`,
      at: Number(r.at),
      from: r.from_id as string,
      to: r.to_id as string,
      label: (r.label as CommsLabel | null) ?? null,
      ref: (r.ref as string | null) ?? null,
      text: r.text as string,
      senderKind: (r.sender_kind as CommsSenderKind | null) ?? null,
    }));
  }

  markCommsScopeRead(scope: string, messageId: string): void {
    const id = commsMessageNumber(messageId);
    if (id === null) return;
    this.db
      .prepare(
        `INSERT INTO comms_reads(thread_id,source_id,offset,block) VALUES (?, 'comms', ?, 0) ON CONFLICT(thread_id,source_id) DO UPDATE SET offset=MAX(offset,excluded.offset)`,
      )
      .run(scope, id);
  }

  commsScopeCursor(scope: string): string | null {
    const r = this.db
      .prepare("SELECT offset FROM comms_reads WHERE thread_id=? AND source_id='comms'")
      .get(scope) as { offset: number } | undefined;
    return r ? `comms:${r.offset}` : null;
  }

  /** Seat delivery receipts, deliberately separate from the operator's UI cursor. */
  commsInboxRead(seatId: string, messageId: string): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null) return false;
    return (
      this.db
        .prepare("SELECT 1 FROM comms_inbox_reads WHERE seat_id=? AND message_id=?")
        .get(seatId, id) !== undefined
    );
  }

  /** Ids of messages `from` sent `to` at or after `since` that `to` has not read, oldest first. */
  unreadCommsFrom(from: string, to: string, since: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM comms WHERE from_id = ? AND to_id = ? AND at >= ?
           AND id NOT IN (SELECT message_id FROM comms_inbox_reads WHERE seat_id = ?)
         ORDER BY id`,
      )
      .all(from, to, since, to) as { id: number }[];
    return rows.map((r) => String(r.id));
  }

  /**
   * Ids of messages `from` sent `to` at or after `since` that `to` has read and not answered (no
   * message from `to` carries `replyTo` naming it, `to` has not reacted to it, and it is not
   * settled: the same closes an open Comms item), oldest first.
   */
  owedCommsFrom(from: string, to: string, since: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM comms c WHERE c.from_id = ? AND c.to_id = ? AND c.at >= ?
           AND c.id IN (SELECT message_id FROM comms_inbox_reads WHERE seat_id = ?)
           AND NOT EXISTS (SELECT 1 FROM comms r WHERE r.from_id = ? AND r.reply_to = c.id)
           AND NOT EXISTS (
             SELECT 1 FROM comms_reactions x WHERE x.message_id = c.id AND x.actor_id = c.to_id
           )
           AND NOT EXISTS (SELECT 1 FROM comms_settlements s WHERE s.message_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM question_choices q WHERE q.message_id = c.id)
         ORDER BY c.id`,
      )
      .all(from, to, since, to, to) as { id: number }[];
    return rows.map((r) => String(r.id));
  }

  markCommsInboxRead(seatId: string, messageIds: readonly string[], at = Date.now()): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO comms_inbox_reads(seat_id,message_id) VALUES (?,?)",
    );
    // the seat took what was sent to it: that is delivery
    const deliver = this.db.prepare(
      "UPDATE comms SET delivered_at = ? WHERE id = ? AND to_id = ? AND delivered_at IS NULL",
    );
    this.host.transaction(() => {
      for (const messageId of messageIds) {
        const id = commsMessageNumber(messageId);
        if (id === null) continue;
        insert.run(seatId, id);
        deliver.run(at, id, seatId);
      }
    }, true);
  }

  /** The hand-offs at or after `since`, oldest first. */
  comms(since: number, targetRunId?: string): CommsRow[] {
    const rows = this.db
      .prepare(
        targetRunId === undefined
          ? `SELECT * FROM (
               SELECT * FROM comms WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?
             ) ORDER BY at, id`
          : `SELECT * FROM (
               SELECT * FROM (
                 SELECT * FROM comms WHERE at >= ? AND target_run_id IS NULL
                 UNION ALL
                 SELECT * FROM comms WHERE at >= ? AND target_run_id = ?
               ) ORDER BY at DESC, id DESC LIMIT ?
             ) ORDER BY at, id`,
      )
      .all(
        since,
        ...(targetRunId === undefined ? [] : [since, targetRunId]),
        LIVE_COMMS_LIMIT,
      ) as Row[];
    // Activity's long-standing feed deliberately remains its compact legacy shape. New Comms
    // readers use the scoped methods above, which include metadata and related rows.
    return rows.map((r) => ({
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
    })) as CommsRow[];
  }

  /** Messages to `to` at or after `since`, with their label: the times FLIGHT's callers began to wait. */
  commsTo(to: string, since: number): { at: number; from: string; label: string | null }[] {
    return (
      this.db
        .prepare("SELECT at, from_id, label FROM comms WHERE to_id = ? AND at >= ? ORDER BY at, id")
        .all(to, since) as { at: number; from_id: string; label: string | null }[]
    ).map((r) => ({ at: r.at, from: r.from_id, label: r.label }));
  }

  /** How many hand-offs `from` sent `to` at or after `since`. */
  commsCountTo(from: string, to: string, since: number): number {
    const r = this.host
      .statement("SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND to_id = ? AND at >= ?")
      .get(from, to, since) as { n: number };
    return r.n;
  }

  /** Stable stored message IDs for one thread, in insertion order. */
  threadComms(id: string, after = 0): (CommsRow & { id: string })[] {
    const rows = this.db
      .prepare(`SELECT * FROM comms WHERE id IN (
          SELECT id FROM (SELECT id FROM comms WHERE from_id = ? AND id > ? ORDER BY id DESC LIMIT ?)
          UNION
          SELECT id FROM (SELECT id FROM comms WHERE to_id = ? AND id > ? ORDER BY id DESC LIMIT ?)
        ) ORDER BY id DESC LIMIT ?`)
      .all(
        id,
        after,
        THREAD_COMMS_LIMIT,
        id,
        after,
        THREAD_COMMS_LIMIT,
        THREAD_COMMS_LIMIT,
      ) as Row[];
    return this.commsRows(rows.reverse());
  }

  /** Prompt metadata remains available even after its body has been read. */
  threadPrompt(id: string): { id: string; at: number } | undefined {
    const row = this.db
      .prepare(
        "SELECT id, at FROM comms WHERE from_id = ? AND to_id = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(COMMS_CAPCOM, id) as { id: number; at: number } | undefined;
    return row && { id: `comms:${row.id}`, at: row.at };
  }

  /** Progress evidence does not need message bodies. */
  commsEvidence(since: number): Pick<CommsRow, "at" | "from" | "ticket">[] {
    return this.db
      .prepare('SELECT at, from_id AS "from", ticket FROM comms WHERE at >= ? ORDER BY at, id')
      .all(since) as Pick<CommsRow, "at" | "from" | "ticket">[];
  }

  threadReadCursors(id: string): Map<string, { offset: number; block: number }> {
    const rows = this.db.prepare("SELECT * FROM comms_reads WHERE thread_id = ?").all(id) as Row[];
    return new Map(
      rows.map((r) => [
        r.source_id as string,
        { offset: r.offset as number, block: r.block as number },
      ]),
    );
  }

  /** Validates ownership without re-reading a transcript window that may have moved on. */
  threadOwnsMessage(id: string, messageId: string): boolean {
    const position = commsPosition(messageId);
    if (!position) return false;
    if (position.source === "comms") {
      return (
        this.db
          .prepare("SELECT 1 FROM comms WHERE id = ? AND (from_id = ? OR to_id = ?)")
          .get(position.offset, id, id) !== undefined
      );
    }
    return this.host.run(position.source.slice("stream:".length))?.agentId === id;
  }

  /** Advance only through the opened snapshot, atomically; stale reads never move backwards. */
  markThreadRead(id: string, messageIds: string[]): void {
    this.host.transaction(() => {
      const update =
        this.db.prepare(`INSERT INTO comms_reads (thread_id, source_id, offset, block) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, source_id) DO UPDATE SET offset = excluded.offset, block = excluded.block
        WHERE excluded.offset > comms_reads.offset OR (excluded.offset = comms_reads.offset AND excluded.block > comms_reads.block)`);
      for (const messageId of messageIds) {
        const p = commsPosition(messageId);
        if (p) update.run(id, p.source, p.offset, p.block);
      }
    });
  }

  /** The newest `limit` messages `from` sent about one run, newest first. */
  commsFromToRun(from: string, runId: string, limit: number): CommsRow[] {
    return this.commsRows(
      this.db
        .prepare(
          "SELECT * FROM comms WHERE from_id = ? AND target_run_id = ? ORDER BY at DESC, id DESC LIMIT ?",
        )
        .all(from, runId, limit) as Row[],
    );
  }
}
