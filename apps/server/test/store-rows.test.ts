import { describe, expect, it } from "vitest";
import * as rows from "../src/store/rows.ts";

describe("store row mappers", () => {
  it("exports the store row mappers", () => {
    expect(Object.keys(rows).sort()).toEqual([
      "compactFlightWake",
      "evidenceOf",
      "parsePlan",
      "queueRow",
      "seatRow",
      "toBoardItem",
      "toCiRun",
      "toEscalation",
      "toFlightDecision",
      "toGuardHit",
      "toQuestion",
      "toReview",
      "toRun",
      "toSample",
    ]);
  });
});
