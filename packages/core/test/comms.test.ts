import { describe, expect, it } from "vitest";
import { COMMS_MESSAGE_MAX, commsMirror } from "../src/comms.ts";

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
