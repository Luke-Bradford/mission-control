import { describe, expect, it } from "vitest";
import { doneWhenCount, doneWhenItems, doneWhenMissingText } from "../src/mcp.ts";

describe("doneWhenItems", () => {
  const body = [
    "## Outcome",
    "- not a done-when line",
    "## Done when",
    "",
    "- [ ] Test: a report missing a line is refused",
    "- [x] Audit shows rounds",
    "  - nested detail, not a line",
    "1. A numbered line",
    "",
    "## Size",
    "- M",
  ].join("\n");

  it("lists the top-level bullets of ## Done when, markers and checkboxes cut off", () => {
    expect(doneWhenItems(body)).toEqual([
      "Test: a report missing a line is refused",
      "Audit shows rounds",
      "A numbered line",
    ]);
    expect(doneWhenCount(body)).toBe(3);
  });

  it("is empty for a ticket with no ## Done when", () => {
    expect(doneWhenItems("## Size\n- M\n")).toEqual([]);
  });

  it("quotes each missing line in the refusal", () => {
    expect(doneWhenMissingText([{ line: 2, text: "Audit shows rounds" }])).toContain(
      '2. "Audit shows rounds"',
    );
  });
});
