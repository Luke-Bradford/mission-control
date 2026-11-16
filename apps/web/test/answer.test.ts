import type { AttentionItem, BriefBinding } from "@mc/core";
import { describe, expect, it } from "vitest";
import { answerTarget, askedQuestion, boundChoice, flightText } from "../src/comms/answer.ts";
import type { FlightSeat } from "../src/flight/flightTypes.ts";
import { BRIEF_REVISION, boundBrief, crewRow, item, SEAT_Q } from "./fixtures.ts";

const FLIGHT: FlightSeat = {
  id: "flight-1",
  call: "FLIGHT-1",
  model: "opus",
  state: "idle",
  live: true,
};
const ROWS = [
  crewRow({ id: "mc-dev-1", kind: "crew" }),
  crewRow({ id: "flight-1", kind: "crew" }),
  crewRow({ id: "shop-app-ta", kind: "loop" }),
];

describe("answerTarget", () => {
  it("an escalation is answered on GitHub", () => {
    expect(answerTarget(item(), ROWS, FLIGHT)).toEqual({ to: "github", url: item().url });
  });

  it("FLIGHT's own question goes to FLIGHT", () => {
    expect(answerTarget({ ...SEAT_Q, agentId: "flight-1" }, ROWS, FLIGHT)).toEqual({
      to: "flight",
    });
  });

  it("a crew seat's item goes to the seat", () => {
    expect(answerTarget(SEAT_Q, ROWS, FLIGHT)).toEqual({ to: "seat", seatId: "mc-dev-1" });
  });

  it("a loop's item goes to FLIGHT", () => {
    const stall = { ...SEAT_Q, agentId: "shop-app-ta" };
    expect(answerTarget(stall, ROWS, FLIGHT)).toEqual({ to: "flight" });
  });
});

describe("flightText", () => {
  it("leads with the key and the about", () => {
    expect(flightText("ask:7", "Which port?", "Use port 5180.")).toBe(
      "Re: ask:7 · Which port?\n\nUse port 5180.",
    );
    expect(flightText("ask:7", "", "Use port 5180.")).toBe("Re: ask:7\n\nUse port 5180.");
  });
  it("keeps the about on one line, so the item's conversation drops only the lead", () => {
    expect(flightText("note:x", "Held.\n\nRun Update  later.", "Why?")).toBe(
      "Re: note:x · Held. Run Update later.\n\nWhy?",
    );
  });
});

describe("askedQuestion", () => {
  it("reads the number from an ask: key", () => {
    expect(askedQuestion("ask:7")).toBe(7);
  });

  it.each(["ask:", "ask:abc", "ask:0", "ask:7x", "note:7", "ask:99999999999999999999"])(
    "gives null for %s",
    (key) => {
      expect(askedQuestion(key)).toBeNull();
    },
  );
});

describe("boundChoice", () => {
  const bound = { ...SEAT_Q, brief: boundBrief() };
  const option = (i: number) => bound.brief.options[i];

  it("returns the ids for a current bound option", () => {
    expect(boundChoice(bound, option(0))).toEqual({ briefId: 31, sourceRevision: BRIEF_REVISION });
  });

  it("refuses stale, unknown, held and unbound", () => {
    const state = (freshness: "stale" | "unknown") => ({
      completeness: "complete" as const,
      freshness,
      reason: "x",
    });
    const cases: AttentionItem[] = [
      { ...bound, brief: { ...bound.brief, state: state("stale") } },
      { ...bound, brief: { ...bound.brief, state: state("unknown") } },
      { ...bound, brief: { ...bound.brief, state: undefined } },
      {
        ...bound,
        hold: { by: "CAPCOM", reason: "wait", condition: { kind: "manual" as const }, at: 1 },
      },
      { ...bound, brief: { ...bound.brief, binding: undefined } },
      { ...bound, brief: { ...bound.brief, id: undefined } },
      {
        ...bound,
        brief: {
          ...bound.brief,
          binding: { ...(bound.brief.binding as BriefBinding), actions: [] },
        },
      },
    ];
    for (const c of cases) expect(boundChoice(c, option(0))).toBeNull();
    expect(boundChoice(bound, { label: "x", answer: "y" })).toBeNull();
  });

  it("no longer limits bound choices to escalations or hub briefs", () => {
    expect(bound.brief.by).toBeUndefined();
    expect(bound.escalationId).toBeNull();
    expect(boundChoice(bound, option(1))).not.toBeNull();
  });
});
