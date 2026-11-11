import { describe, expect, it } from "vitest";
import { COMMS_MESSAGE_MAX, commsMirror, type FlightConversationPage } from "../src/comms.ts";

describe("commsMirror", () => {
  it("keeps a short message and replaces a long delivery with its pointer", () => {
    expect(commsMirror("short", "pointer")).toBe("short");
    expect(commsMirror("x".repeat(COMMS_MESSAGE_MAX + 1), "full text was sent to the seat.")).toBe(
      "full text was sent to the seat.",
    );
  });

  it("caps a pointer by code point", () => {
    const mirrored = commsMirror(
      "x".repeat(COMMS_MESSAGE_MAX + 1),
      "😀".repeat(COMMS_MESSAGE_MAX + 1),
    );
    expect(Array.from(mirrored)).toHaveLength(COMMS_MESSAGE_MAX);
  });
});

describe("FlightConversationPage", () => {
  it("allows an optional FLIGHT run status from newer servers", () => {
    const page: FlightConversationPage = {
      messages: [],
      hasMore: false,
      cursor: null,
      unread: 0,
      flight: { live: true, since: 1_794_206_400_000, runId: "flight-run" },
    };

    expect(page.flight).toEqual({ live: true, since: 1_794_206_400_000, runId: "flight-run" });
  });
});
