import { describe, expect, it } from "vitest";
import { answerTarget, flightText } from "../src/comms/answer.ts";
import type { FlightSeat } from "../src/flight/flightTypes.ts";
import { crewRow, item, SEAT_Q } from "./fixtures.ts";

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
});
