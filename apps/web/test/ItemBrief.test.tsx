import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BriefOptions, ItemBrief } from "../src/comms/ItemBrief.tsx";
import { brief } from "./fixtures.ts";

describe("decision brief evidence", () => {
  it("shows the catch-up and checked sources as inert text", () => {
    render(
      <ItemBrief
        brief={brief({
          catchUp: {
            kind: "old",
            line: "An earlier decision",
            story: ["The draft was reviewed."],
            aware: ["The pilot date is fixed."],
          },
          checked: [{ source: "Code", finding: "Rules use customer_id." }],
        })}
      />,
    );
    expect(screen.getByText("So far")).toBeTruthy();
    expect(screen.getByText("Be aware")).toBeTruthy();
    expect(screen.getByText("Old thread")).toBeTruthy();
    expect(screen.getByText("Rules use customer_id.")).toBeTruthy();
  });
  it("shows unavailable evidence for legacy briefs", () => {
    render(<ItemBrief brief={brief()} />);
    expect(screen.getByText("So far")).toBeTruthy();
    expect(screen.getByText("Be aware")).toBeTruthy();
    expect(screen.getByText("Checked sources unavailable.")).toBeTruthy();
    expect(screen.getAllByText("Use 5174.")).toHaveLength(2);
  });
  it("marks the recommendation by identity and never executes a description", () => {
    const pick = vi.fn();
    render(
      <BriefOptions
        options={[
          { id: "a", label: "Same", answer: "first", description: "Open the draft" },
          { id: "b", label: "Same", answer: "second", description: "Keep the draft" },
        ]}
        recommendedOptionId="b"
        live
        disabled={false}
        variant="panel"
        onPick={pick}
      />,
    );
    const cards = screen.getAllByRole("button");
    expect(cards[0]?.textContent).not.toContain("FLIGHT recommends");
    expect(cards[1]?.textContent).toContain("FLIGHT recommends");
    fireEvent.click(screen.getByText("Open the draft"));
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ answer: "first" }));
    expect(document.querySelector("a")).toBeNull();
  });
});

describe("approval brief", () => {
  it("shows the approval effect without decision sections", () => {
    render(
      <ItemBrief brief={brief({ recommendation: "The approved draft is queued." })} approval />,
    );
    expect(screen.getByText("If you approve")).toBeTruthy();
    expect(screen.getByText("The approved draft is queued.")).toBeTruthy();
    expect(screen.queryByText("Why it came to you")).toBeNull();
    expect(screen.queryByText("What FLIGHT checked")).toBeNull();
  });
});

it("shows legacy reasoning in Why it came to you without an option identity", () => {
  render(
    <ItemBrief
      brief={brief({ recommendedOptionId: undefined, recommendation: "Legacy reasoning" })}
    />,
  );
  const heading = screen.getByText("Why it came to you");
  expect(heading.nextElementSibling?.textContent).toBe("Legacy reasoning");
  expect(screen.queryByText("Reason unavailable.")).toBeNull();
});

it("shows unavailable reasoning when the recommendation is empty", () => {
  render(
    <ItemBrief
      brief={brief({
        recommendedOptionId: "a",
        options: [{ id: "a", label: "A", answer: "A" }],
        recommendation: "",
      })}
    />,
  );
  expect(screen.getByText("Why it came to you").nextElementSibling?.textContent).toBe(
    "Reason unavailable.",
  );
});
