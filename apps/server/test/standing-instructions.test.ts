import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatInstructionBlock } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import { rolePrompt } from "../src/runtime/brief.ts";
import { directionKey, instructionEnvelope } from "../src/runtime/instruction-context.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const open = (path = ":memory:") => {
  const store = new Store(path);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const note = (text: string) => ({ kind: "text" as const, text });
const seat = { id: "builder", role: "GUIDO", accountId: "claude", model: "haiku", area: [] };

describe("durable instructions", () => {
  it("retains immutable replacement and revoked history across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "instruction-store-"));
    const path = join(dir, "db.sqlite");
    try {
      const first = open(path);
      const old = first.instructions.create(null, note("First order"), "operator", 1).entry;
      const replacement = first.instructions.create(
        null,
        { ...note("Second order"), replacesId: old.id },
        "operator",
        2,
      ).entry;
      const second = open(path);
      expect(second.instructions.get(old.id)).toMatchObject({
        text: "First order",
        at: 1,
        revokedAt: 2,
      });
      expect(second.instructions.list(null)).toMatchObject({
        active: [replacement],
        history: [{ id: old.id }],
        nextCursor: null,
      });
      const revision = second.instructions.revision();
      expect(second.instructions.revoke(old.id, null, "operator", 99).changed).toBe(false);
      expect(second.instructions.revision()).toBe(revision);
    } finally {
      for (const store of stores.splice(0)) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects protected/wrong-target writes without changing history, notices or audit", () => {
    const store = open();
    const order = store.instructions.create(null, note("Only the operator"), "operator", 1).entry;
    const instruction = store.instructions.create(
      "builder",
      note("Operator seat rule"),
      "operator",
      2,
    ).entry;
    const snapshot = () =>
      JSON.stringify([
        store.instructions.list(null),
        store.instructions.seat("builder"),
        store.instructions.notices(),
        store.flightDecisions(0, 100),
        store.instructions.revision(),
      ]);
    const before = snapshot();
    expect(() => store.instructions.create(null, note("Forged"), "flight", 3)).toThrow(/operator/);
    expect(() => store.instructions.revoke(order.id, null, "flight", 3)).toThrow(/operator/);
    expect(() => store.instructions.revoke(instruction.id, "wrong", "operator", 3)).toThrow(
      /target/,
    );
    expect(() =>
      store.instructions.create(
        "builder",
        { ...note("Forged edit"), replacesId: instruction.id },
        "flight",
        3,
      ),
    ).toThrow(/operator/);
    expect(snapshot()).toBe(before);
  });
  it("rejects count/byte capacity atomically and keeps all accepted text", () => {
    const store = open();
    for (let i = 0; i < 64; i++) store.instructions.create(null, note(`Order ${i}`), "operator", i);
    expect(() => store.instructions.create(null, note("Overflow"), "operator", 65)).toThrow(/64/);
    expect(store.instructions.active(null)).toHaveLength(64);
    expect(() =>
      store.instructions.create(null, { ...note("x".repeat(4001)), replacesId: 1 }, "operator", 66),
    ).toThrow(/text/);
    expect(store.instructions.get(1)?.revokedAt).toBeNull();
    const bytes = open();
    const text = "🚀".repeat(2000);
    let accepted = 0;
    while (accepted < 64) {
      try {
        bytes.instructions.create(null, note(text), "operator", accepted);
        accepted++;
      } catch {
        break;
      }
    }
    expect(accepted).toBeGreaterThan(1);
    expect(accepted).toBeLessThan(64);
    expect(bytes.instructions.active(null)).toHaveLength(accepted);
    for (const e of bytes.instructions.active(null)) expect(e.kind === "text" && e.text).toBe(text);
  });
  it("paginates history without capping active entries", () => {
    const store = open();
    for (let i = 0; i < 4; i++) {
      const e = store.instructions.create(null, note(String(i)), "operator", i).entry;
      store.instructions.revoke(e.id, null, "operator", 10 + i);
    }
    const active = store.instructions.create(null, note("Active"), "operator", 20).entry;
    const first = store.instructions.list(null, undefined, 2);
    const next = store.instructions.list(null, first.nextCursor ?? undefined, 2);
    expect(first.history.map((e) => e.id)).toEqual([4, 3]);
    expect(next.history.map((e) => e.id)).toEqual([2, 1]);
    expect(next.active).toEqual([active]);
  });
  it("keeps operator focus and explicit clear above FLIGHT, including raw-config reloads", () => {
    const store = open();
    const instructions = store.instructions;
    expect(instructions.syncFocus(seat, 1)).toBeNull();
    const lower = instructions.create(
      seat.id,
      { kind: "focus", focus: "lane:work" },
      "flight",
      2,
    ).entry;
    expect(instructions.syncFocus(seat, 3)).toBe("lane:work");
    instructions.create(seat.id, { kind: "focus", focus: null }, "operator", 4);
    expect(instructions.focus(seat.id)).toMatchObject({ effectiveFocus: null });
    expect(() => instructions.create(seat.id, { kind: "focus", focus: null }, "flight", 5)).toThrow(
      /operator focus/,
    );
    const upper = instructions.active(seat.id).find((e) => e.by === "operator");
    expect(upper).toBeTruthy();
    instructions.revoke(upper!.id, seat.id, "operator", 6);
    expect(instructions.focus(seat.id)).toMatchObject({
      effectiveFocus: "lane:work",
      focusInstructionId: lower.id,
    });
    expect(instructions.syncFocus({ ...seat, focus: "label:urgent" }, 7)).toBe("label:urgent");
    const imported = instructions.active(seat.id).find((e) => e.source === "legacy-config");
    expect(imported).toMatchObject({ by: "operator", at: 7 });
    expect(instructions.syncFocus({ ...seat, focus: "label:urgent" }, 8)).toBe("label:urgent");
    expect(instructions.syncFocus(seat, 9)).toBeNull();
    expect(instructions.active(seat.id).filter((e) => e.by === "operator")).toHaveLength(1);
  });
  it("records exactly one instruction decision per real FLIGHT mutation", () => {
    const store = open();
    const first = store.instructions.create(
      seat.id,
      note("First"),
      "flight",
      1,
      "Task basis",
    ).entry;
    const next = store.instructions.create(
      seat.id,
      { ...note("Next"), replacesId: first.id },
      "flight",
      2,
      "Changed basis",
    ).entry;
    expect(store.flightDecisions(0, 10)).toHaveLength(2);
    store.instructions.revoke(next.id, seat.id, "flight", 3, "Finished");
    store.instructions.revoke(next.id, seat.id, "flight", 4, "Retry");
    expect(store.flightDecisions(0, 10)).toHaveLength(3);
    expect(store.flightDecisions(0, 10).every((e) => e.kind === "instruction")).toBe(true);
  });
});

describe("final provider guidance snapshot", () => {
  it("repeats complete guidance on every delivery and resolves queued changes at delivery", () => {
    const store = open();
    store.setSetting(
      directionKey("run"),
      JSON.stringify({ sha: "a".repeat(40), text: "Direction text", restored: false }),
    );
    const order = store.instructions.create(null, note("Operator order"), "operator", 1).entry;
    const personal = store.instructions.create(
      seat.id,
      note("Seat instruction"),
      "operator",
      2,
    ).entry;
    for (const message of [
      "initial memory",
      "repeat memory",
      "operator message",
      "resumed memory",
    ]) {
      const envelope = instructionEnvelope(store, seat, "run", true, message);
      expect(envelope.text.indexOf("Direction text")).toBeLessThan(
        envelope.text.indexOf('"text":"Operator order"'),
      );
      expect(envelope.text.indexOf('"text":"Operator order"')).toBeLessThan(
        envelope.text.indexOf(message),
      );
      expect(envelope.text).toContain("Seat instruction");
    }
    const prepared = "old prepared memory";
    store.instructions.revoke(order.id, null, "operator", 3);
    store.instructions.revoke(personal.id, seat.id, "operator", 4);
    const delivered = instructionEnvelope(store, seat, "run", true, prepared);
    expect(delivered.text).not.toContain('"text":"Operator order"');
    expect(delivered.text).toContain("No active operator orders.");
    expect(delivered.text).toContain("IDs absent here are revoked or replaced");
    expect(store.getSetting("instruction.delivered:run")).toBeNull();
  });
  it("puts seat guidance after both repo rule files, and carries a complete live clear", () => {
    const store = open();
    const e = store.instructions.create(seat.id, note("Seat rule"), "operator", 1).entry;
    const block = seatInstructionBlock(store.instructions.active(seat.id));
    const prompt = rolePrompt("Role", "Claude rules", "", "Agent rules", block);
    expect(prompt.indexOf("Agent rules")).toBeLessThan(prompt.indexOf("Seat rule"));
    store.instructions.revoke(e.id, seat.id, "operator", 2);
    expect(instructionEnvelope(store, seat, "run", false, "Inbox notice").text).toContain(
      "No active seat instructions.",
    );
  });
});
