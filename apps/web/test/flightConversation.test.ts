import type { AgentStream, StreamEvent } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  type DockRow,
  dockRows,
  kindLabel,
  overturnText,
  type PendingMsg,
  withPending,
} from "../src/flight/conversation.ts";
import { type FlightDecision, MC_LINE_PREFIX } from "../src/flight/flightTypes.ts";

const ev = (
  id: string,
  kind: StreamEvent["kind"],
  text: string,
  at: number | null,
): StreamEvent => ({
  id,
  kind,
  text,
  at,
});
const stream = (events: StreamEvent[]): AgentStream => ({
  runId: "r1",
  events,
  truncated: false,
  lastOutputAt: null,
  reason: null,
});
export const decision = (
  id: string,
  at: number,
  over: Partial<FlightDecision> = {},
): FlightDecision => ({
  id: Number(id.replace(/\D/g, "")),
  targetRunId: null,
  ref: null,
  questionId: null,
  at,
  seatId: null,
  kind: "answer",
  about: "a question",
  decision: "yes",
  basis: "the spec",
  ...over,
});

describe("dockRows", () => {
  it("op lines: a wake is one hub line, a plain op is you, a msg is flight, the rest are dropped", () => {
    const rows = dockRows(
      stream([
        ev("0:0", "op", `${MC_LINE_PREFIX} Wake: 2 questions\n{"a":1}`, 10),
        ev("1:0", "op", "hello", 11),
        ev("2:0", "msg", "hi @CAPCOM", 12),
        ev("3:0", "tool", "x", 13),
        ev("4:0", "think", "x", 14),
        ev("5:0", "sys", "x", 15),
      ]),
      [],
    );
    expect(rows.map((r) => [r.kind, r.id])).toEqual([
      ["hub", "0:0"],
      ["you", "1:0"],
      ["flight", "2:0"],
    ]);
    expect(rows[0]).toMatchObject({ text: "Wake: 2 questions" });
  });

  it("decisions interleave by time; one from before the run's first event is dropped", () => {
    const rows = dockRows(
      stream([ev("a", "op", "one", 100), ev("b", "msg", "two", 200), ev("c", "msg", "three", 300)]),
      [decision("1", 50), decision("2", 250), decision("3", 400)],
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "d:2", "c", "d:3"]);
  });

  it("with no stream events, the newest 20 decisions are kept", () => {
    const all = Array.from({ length: 25 }, (_, i) => decision(`d${i}`, i));
    const rows = dockRows(undefined, all);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.id).toBe("d:5");
  });

  it("a long hub line is cut at 160 characters with …", () => {
    const [row] = dockRows(stream([ev("a", "op", `${MC_LINE_PREFIX} ${"x".repeat(300)}`, 1)]), []);
    expect(row?.kind === "hub" && row.text).toBe(`${"x".repeat(159)}…`);
    expect(row?.kind === "hub" && row.text.length).toBe(160);
  });
});

describe("overturnText", () => {
  it("names the seat to hold, when there is one", () => {
    const d = decision("d1", 1);
    expect(overturnText(d, "GUIDO-1")).toBe(
      "I am overturning your decision 1 (a question: yes). Tell GUIDO-1 to hold that point. Then ask me what I prefer.",
    );
    expect(overturnText(d, null)).toBe(
      "I am overturning your decision 1 (a question: yes). Then ask me what I prefer.",
    );
  });
});

describe("kindLabel", () => {
  it("labels known kinds and shows an unknown kind as written", () => {
    expect(kindLabel("promote")).toBe("Promoted");
    expect(kindLabel("start")).toBe("Started");
    expect(kindLabel("later-kind")).toBe("later-kind");
  });
});

describe("withPending", () => {
  const you = (id: string, text: string): DockRow => ({ kind: "you", id, at: 1, text });
  const sent = (text: string, seen: number): PendingMsg => ({ id: "p:0", text, at: 5, seen });

  it("keeps a message open, as a pending you row, until the stream holds another copy", () => {
    const rows = [you("a", "go")];
    const first = withPending(rows, [sent("go", 1)]);
    expect(first.open).toHaveLength(1);
    expect(first.rows.at(-1)).toMatchObject({ kind: "you", id: "p:0", text: "go", pending: true });
    const second = withPending([...rows, you("b", "go")], [sent("go", 1)]);
    expect(second.open).toEqual([]);
    expect(second.rows).toHaveLength(2);
  });

  it("drops a settled message and keeps one still waiting", () => {
    const { open, rows } = withPending(
      [you("a", "done")],
      [sent("done", 0), { ...sent("later", 0), id: "p:1" }],
    );
    expect(open.map((p) => p.text)).toEqual(["later"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "p:1"]);
  });
});
