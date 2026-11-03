import type { DatabaseSync } from "node:sqlite";
import {
  INSTRUCTION_ACTIVE_MAX,
  INSTRUCTION_BYTES_MAX,
  INSTRUCTION_TEXT_MAX,
  type InstructionAuthor,
  type InstructionMutation,
  instructionSnapshot,
  type SeatInstructionList,
  type StandingInstruction,
  type StandingInstructionInput,
  type StandingInstructionList,
} from "@mc/core";
import { z } from "zod";
import type { CrewSeatConfig } from "./config.ts";
import { seatFocus } from "./focus.ts";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const InstructionInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string().trim().min(1).max(INSTRUCTION_TEXT_MAX),
    replacesId: positiveId.optional(),
  }),
  z.strictObject({ kind: z.literal("focus"), focus: seatFocus, replacesId: positiveId.optional() }),
]);
export const OrderInput = z.strictObject({
  text: z.string().trim().min(1).max(INSTRUCTION_TEXT_MAX),
  replacesId: positiveId.optional(),
});
export class InstructionError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}
type Row = Record<string, unknown>;
const row = (r: Row): StandingInstruction =>
  ({
    id: Number(r.id),
    seatId: r.seat_id as string | null,
    by: r.by as InstructionAuthor,
    at: Number(r.at),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    source: r.source as StandingInstruction["source"],
    ...(r.kind === "focus"
      ? { kind: "focus" as const, focus: r.text as string | null }
      : { kind: "text" as const, text: r.text as string }),
  }) as StandingInstruction;

/** The canonical store for guidance; config remains a separately tracked import source. */
export class StandingInstructions {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS standing_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, seat_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('text','focus')),
      text TEXT, by TEXT NOT NULL CHECK(by IN ('operator','flight')), at INTEGER NOT NULL,
      revoked_at INTEGER, source TEXT NOT NULL DEFAULT 'saved' CHECK(source IN ('saved','legacy-config')),
      CHECK(seat_id IS NOT NULL OR (kind = 'text' AND by = 'operator')),
      CHECK(kind != 'text' OR (text IS NOT NULL AND length(text) > 0)));
      CREATE INDEX IF NOT EXISTS standing_instructions_target ON standing_instructions(seat_id, id);
      CREATE TABLE IF NOT EXISTS standing_instruction_notices (
      instruction_id INTEGER NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL CHECK(by IN ('operator','flight')), comms_id TEXT,
      PRIMARY KEY(instruction_id, action));`);
  }
  private inTransaction = false;
  private transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  get(id: number): StandingInstruction | null {
    const value = this.db.prepare("SELECT * FROM standing_instructions WHERE id = ?").get(id);
    return value ? row(value) : null;
  }
  active(seatId: string | null): StandingInstruction[] {
    return this.db
      .prepare(
        "SELECT * FROM standing_instructions WHERE seat_id IS ? AND revoked_at IS NULL ORDER BY at, id",
      )
      .all(seatId)
      .map(row);
  }
  hasTarget(seatId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM standing_instructions WHERE seat_id = ? LIMIT 1")
        .get(seatId) !== undefined
    );
  }
  list(
    seatId: string | null,
    before = Number.MAX_SAFE_INTEGER,
    limit = 50,
  ): StandingInstructionList {
    const size = Math.max(1, Math.min(100, limit));
    const history = this.db
      .prepare(
        "SELECT * FROM standing_instructions WHERE seat_id IS ? AND revoked_at IS NOT NULL AND id < ? ORDER BY id DESC LIMIT ?",
      )
      .all(seatId, before, size + 1)
      .map(row);
    return {
      active: this.active(seatId),
      history: history.slice(0, size),
      nextCursor: history.length > size ? history[size - 1].id : null,
    };
  }
  focus(seatId: string): { effectiveFocus: string | null; focusInstructionId: number | null } {
    const stored = this.db
      .prepare(
        "SELECT * FROM standing_instructions WHERE seat_id = ? AND kind = 'focus' AND revoked_at IS NULL ORDER BY CASE by WHEN 'operator' THEN 0 ELSE 1 END, id DESC LIMIT 1",
      )
      .get(seatId);
    const value = stored ? row(stored) : null;
    return {
      effectiveFocus: value?.kind === "focus" ? value.focus : null,
      focusInstructionId: value?.id ?? null,
    };
  }
  seat(seatId: string, before?: number, limit?: number): SeatInstructionList {
    return { ...this.list(seatId, before, limit), ...this.focus(seatId) };
  }
  private checkEntry(
    id: number,
    seatId: string | null,
    by: InstructionAuthor,
  ): StandingInstruction {
    const value = this.get(id);
    if (!value || value.seatId !== seatId)
      throw new InstructionError(404, "Instruction target was not found.");
    if (by === "flight" && value.by === "operator")
      throw new InstructionError(403, "Only the operator can change an operator instruction.");
    return value;
  }
  private audit(entry: StandingInstruction, action: string, basis: string): void {
    if (entry.by !== "flight") return;
    this.db
      .prepare(
        `INSERT INTO flight_decisions(at,kind,seat_id,about,decision,basis) VALUES (?,'instruction',?,?,?,?)`,
      )
      .run(
        entry.revokedAt ?? entry.at,
        entry.seatId,
        `instruction:${entry.id}`,
        `${action} ${entry.kind} instruction ${entry.id}`,
        basis,
      );
  }
  private changed(): void {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('instruction.revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      )
      .run();
  }
  private revokeRow(
    entry: StandingInstruction,
    at: number,
    by: InstructionAuthor,
    basis: string,
    audit = true,
  ): void {
    this.changed();
    this.db
      .prepare("UPDATE standing_instructions SET revoked_at = ? WHERE id = ?")
      .run(at, entry.id);
    if (entry.seatId !== null)
      this.db
        .prepare(
          "INSERT INTO standing_instruction_notices(instruction_id,action,by) VALUES (?, 'revoked', ?)",
        )
        .run(entry.id, by);
    // Authorship does not change when the operator revokes a FLIGHT entry.
    if (by === "flight" && audit) this.audit({ ...entry, revokedAt: at }, "Revoked", basis);
  }
  create(
    seatId: string | null,
    input: StandingInstructionInput,
    by: InstructionAuthor,
    at: number,
    basis = "Operator instruction",
    source: StandingInstruction["source"] = "saved",
  ): InstructionMutation {
    const parsed = InstructionInput.safeParse(input);
    if (!parsed.success)
      throw new InstructionError(400, "Use nonempty instruction text or valid focus selectors.");
    input = parsed.data;
    if (seatId === null && (by !== "operator" || input.kind !== "text"))
      throw new InstructionError(403, "Only the operator can save a global order.");
    return this.transaction(() => {
      const old =
        input.replacesId === undefined ? null : this.checkEntry(input.replacesId, seatId, by);
      if (old?.revokedAt !== null && old !== null)
        throw new InstructionError(
          409,
          "The instruction was already revoked. Reload before editing.",
        );
      if (
        input.kind === "focus" &&
        by === "flight" &&
        this.active(seatId).some((e) => e.kind === "focus" && e.by === "operator")
      )
        throw new InstructionError(
          409,
          "An operator focus is active. Ask the operator to change or revoke it.",
        );
      const replaced = new Map<number, StandingInstruction>();
      if (old) replaced.set(old.id, old);
      if (input.kind === "focus")
        for (const e of this.active(seatId))
          if (e.kind === "focus" && e.by === by) replaced.set(e.id, e);
      for (const e of replaced.values()) this.revokeRow(e, at, by, basis, false);
      const inserted = this.db
        .prepare(
          "INSERT INTO standing_instructions(seat_id,kind,text,by,at,source) VALUES (?,?,?,?,?,?)",
        )
        .run(seatId, input.kind, input.kind === "text" ? input.text : input.focus, by, at, source);
      const entry = this.get(Number(inserted.lastInsertRowid)) as StandingInstruction;
      const active = this.active(seatId);
      if (
        active.length > INSTRUCTION_ACTIVE_MAX ||
        Buffer.byteLength(instructionSnapshot(active), "utf8") > INSTRUCTION_BYTES_MAX
      )
        throw new InstructionError(
          409,
          "Active instructions exceed 64 entries or 64 KiB. Revoke an entry before saving.",
        );
      if (seatId !== null)
        this.db
          .prepare(
            "INSERT INTO standing_instruction_notices(instruction_id,action,by) VALUES (?, 'saved', ?)",
          )
          .run(entry.id, by);
      this.audit(entry, "Saved", basis);
      this.changed();
      return { entry, changed: true, ...(seatId === null ? {} : this.focus(seatId)) };
    });
  }
  revoke(
    id: number,
    seatId: string | null,
    by: InstructionAuthor,
    at: number,
    basis = "Operator revocation",
  ): InstructionMutation {
    return this.transaction(() => {
      const entry = this.checkEntry(id, seatId, by);
      if (entry.revokedAt !== null)
        return { entry, changed: false, ...(seatId === null ? {} : this.focus(seatId)) };
      this.revokeRow(entry, at, by, basis);
      return {
        entry: { ...entry, revokedAt: at },
        changed: true,
        ...(seatId === null ? {} : this.focus(seatId)),
      };
    });
  }
  /** Raw config imports are tracked independently of the effective focus projection. */
  syncFocus(seat: Pick<CrewSeatConfig, "id" | "focus">, at = Date.now()): string | null {
    const key = `instruction.config-focus:${seat.id}`;
    const raw = JSON.stringify(
      seat.focus === undefined ? { present: false } : { present: true, value: seat.focus },
    );
    const previous = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
    if (previous !== raw)
      this.transaction(() => {
        if (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value === raw)
          return;
        if (seat.focus !== undefined || previous !== undefined)
          this.create(
            seat.id,
            { kind: "focus", focus: seat.focus ?? null },
            "operator",
            at,
            "Imported config focus",
            "legacy-config",
          );
        this.db
          .prepare(
            "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(key, raw);
      });
    return this.focus(seat.id).effectiveFocus;
  }
  revision(): string {
    return String(
      this.db.prepare("SELECT value FROM settings WHERE key = 'instruction.revision'").get()
        ?.value ?? "0",
    );
  }
  notices(): { id: number; action: string; by: InstructionAuthor; entry: StandingInstruction }[] {
    return (
      this.db
        .prepare(
          "SELECT instruction_id,action,by FROM standing_instruction_notices WHERE comms_id IS NULL ORDER BY instruction_id,action",
        )
        .all() as Row[]
    ).map((n) => ({
      id: Number(n.instruction_id),
      action: String(n.action),
      by: n.by as InstructionAuthor,
      entry: this.get(Number(n.instruction_id)) as StandingInstruction,
    }));
  }
  noticeDelivery(id: number, action: string): "pending" | "inbox" {
    const notice = this.db
      .prepare(
        "SELECT comms_id FROM standing_instruction_notices WHERE instruction_id = ? AND action = ?",
      )
      .get(id, action);
    return notice?.comms_id == null ? "pending" : "inbox";
  }
  noticeStored(id: number, action: string, commsId: string): void {
    this.db
      .prepare(
        "UPDATE standing_instruction_notices SET comms_id = ? WHERE instruction_id = ? AND action = ?",
      )
      .run(commsId, id, action);
  }
}
