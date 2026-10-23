import { describe, expect, it } from "vitest";
import { flightTurnShort, flightTurnText, wakeKey, wakeKeyPrefix } from "../src/flight.ts";

describe("flight turn texts", () => {
  it("keeps the wake key", () => {
    expect(wakeKey("r", 3)).toBe("flight:wake:r:3");
    expect(wakeKeyPrefix("r")).toBe("flight:wake:r:");
  });

  it("words the turn", () => {
    expect(flightTurnText(23, 41)).toBe("turn 23 of 41, then a fresh session");
    expect(flightTurnShort(23, 41)).toBe("turn 23 of 41");
  });
});

it("keeps legacy briefs and drafts valid beside the complete additive response", async () => {
  const { FLIGHT_WATCH_LIMIT, FLIGHT_INCOMING_LIMIT } = await import("../src/index.ts");
  const legacyBrief: import("../src/index.ts").FlightBriefView = { session: null, sections: [] };
  const legacyDraft: import("../src/index.ts").ReplyDraft = {
    id: 1,
    target: "demo#41",
    kind: "issue",
    text: "Preview ready",
    createdAt: 1,
    state: "pending",
  };
  const complete: import("../src/index.ts").FlightBriefView = {
    ...legacyBrief,
    watch: [
      {
        id: "preview",
        state: "info",
        title: "Preview ready",
        detail: "Inspect it",
        catchUp: { kind: "new", line: "Arrived today" },
        next: "See draft",
        updatedAt: 2,
        action: { kind: "draft", draftId: 1, target: "demo#41" },
      },
    ],
    planned: [{ id: "check-preview", title: "Check preview", at: 3, createdAt: 1 }],
    drafts: [
      {
        ...legacyDraft,
        to: "Preview team",
        via: "Teams",
        where: "Preview channel",
        context: "Preview check",
        state: "copied",
        completedAt: 2,
      },
    ],
  };
  const incoming: import("../src/index.ts").FlightIncomingView = {
    entries: [
      {
        id: "arrival",
        source: "Board",
        arrivalId: "demo#41",
        version: "1",
        arrivedAt: 1,
        at: 2,
        text: "Preview",
        outcome: "No action",
        detail: "Already covered",
      },
    ],
  };
  expect(complete.watch?.[0]?.action?.kind).toBe("draft");
  expect(legacyDraft.completedAt).toBeUndefined();
  expect(incoming.entries[0]?.outcome).toBe("No action");
  expect(FLIGHT_WATCH_LIMIT).toBe(100);
  expect(FLIGHT_INCOMING_LIMIT).toBe(100);
});
