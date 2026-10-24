import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIEF_LINES, BriefOptions, ItemBrief } from "../src/comms/ItemBrief.tsx";
import { brief } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("decision brief evidence", () => {
  it("renders the full brief in order, including checked basis and action references", () => {
    render(
      <ItemBrief
        brief={brief({
          original: "Original question",
          assessment: "FLIGHT's assessment",
          basis: "Read the config and the latest run",
          did: [{ action: "Checked the preview", refs: ["run:123"] }],
          ask: "Choose a preview port",
        })}
      />,
    );
    expect(screen.getAllByRole("heading").map((el) => el.textContent)).toEqual([
      "The question",
      "FLIGHT's view",
      "What FLIGHT did",
      "What FLIGHT needs from you",
    ]);
    for (const text of [
      "Original question",
      "FLIGHT's assessment",
      "checked: Read the config and the latest run",
      "Checked the preview",
      "run:123",
      "Choose a preview port",
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText("Checked the preview").closest("li")?.textContent).toContain("run:123");
    expect(screen.queryByText("Fallback question")).toBeNull();
  });

  it.each([undefined, []])("omits empty actions (%s)", (did) => {
    render(<ItemBrief original="Question" brief={brief({ did })} />);
    expect(screen.queryByRole("heading", { name: "What FLIGHT did" })).toBeNull();
  });

  it("uses source text, context and recommendation for legacy briefs", () => {
    render(<ItemBrief original="Source question" brief={brief()} />);
    for (const text of [
      "Source question",
      "The dev seat asks which port to preview on.",
      "Use 5174.",
      "checked: read config",
    ])
      expect(screen.getByText(text)).toBeTruthy();
  });

  it("renders only the question without a brief", () => {
    render(<ItemBrief original="Source question" />);
    expect(screen.getAllByRole("heading").map((el) => el.textContent)).toEqual(["The question"]);
  });

  it("folds a 30-line assessment to 8 lines, reveals all of it, then folds again", () => {
    const assessment = Array.from({ length: 30 }, (_, i) => `Assessment line ${i + 1}`).join("\n");
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.textContent?.includes("Assessment line") ? 600 : 20;
    });
    const computedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = computedStyle(el);
      Object.defineProperty(style, "lineHeight", { value: "20px" });
      return style;
    });
    const { container } = render(
      <ItemBrief original="Question stays above" brief={brief({ assessment })} />,
    );
    const question = screen.getByRole("heading", { name: "The question" }).parentElement;
    const content = screen
      .getByText(/Assessment line 30/)
      .closest(".expandable-content") as HTMLElement;
    expect(content.style.webkitLineClamp).toBe(String(BRIEF_LINES));
    fireEvent.click(screen.getByRole("button", { name: "Show more, FLIGHT's view" }));
    expect(content.style.webkitLineClamp).toBe("unset");
    expect(content.textContent).toContain(assessment);
    expect(container.querySelector(".brief-section")).toBe(question);
    fireEvent.click(screen.getByRole("button", { name: "Show less, FLIGHT's view" }));
    expect(content.style.webkitLineClamp).toBe(String(BRIEF_LINES));
    expect(container.querySelector(".brief-section")).toBe(question);
  });

  it("shows all 10 lines without a disclosure", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    const computedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = computedStyle(el);
      Object.defineProperty(style, "lineHeight", { value: "20px" });
      return style;
    });
    render(<ItemBrief original="Question" brief={brief({ assessment: "Line\n".repeat(10) })} />);
    expect(screen.queryByRole("button", { name: "Show more, FLIGHT's view" })).toBeNull();
  });

  it("marks the option by identity and shows the entire recommendation", () => {
    const pick = vi.fn();
    const recommendation = "Choose the second option because ".repeat(15);
    render(
      <BriefOptions
        options={[
          { id: "a", label: "Same", answer: "first", description: "Open the draft" },
          { id: "b", label: "Same", answer: "second", description: "Keep the draft" },
        ]}
        recommendedOptionId="b"
        recommendation={recommendation}
        live
        disabled={false}
        variant="panel"
        onPick={pick}
      />,
    );
    const cards = document.querySelectorAll(".opt");
    expect(cards[0]?.textContent).not.toContain("FLIGHT recommends");
    expect(cards[1]?.textContent).toContain(`FLIGHT recommends${recommendation}`);
    fireEvent.click(screen.getAllByRole("button", { name: "Same" })[0] as HTMLElement);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ answer: "first" }));
    expect(document.querySelector("a")).toBeNull();
  });
});

it("prefers loaded source content and leaves navigation and basis outside the folds", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  render(
    <ItemBrief
      original={<p>Loaded source question</p>}
      links={<a href="https://github.com/example/repo/issues/1">Open on GitHub ↗</a>}
      brief={brief({ original: "Raw source JSON", basis: "source evidence" })}
    />,
  );
  expect(screen.getByText("Loaded source question")).toBeTruthy();
  expect(screen.queryByText("Raw source JSON")).toBeNull();
  expect(screen.getByRole("button", { name: "Show more, The question" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open on GitHub ↗" }).closest(".expandable")).toBeNull();
  expect(screen.getByText("checked: source evidence").closest(".expandable")).toBeNull();
});

it("retains catch-up and checked findings in the new sections", () => {
  render(
    <ItemBrief
      brief={brief({
        catchUp: {
          kind: "old",
          line: "Returned for review",
          story: ["First investigated"],
          aware: ["Review pending"],
        },
        checked: [{ source: "run:42", finding: "Passed validation" }],
      })}
    />,
  );
  for (const text of [
    "Old thread",
    "Returned for review",
    "First investigated",
    "Review pending",
    "run:42",
    "Passed validation",
  ])
    expect(screen.getByText(text)).toBeTruthy();
  const question = screen.getByRole("heading", { name: "The question" });
  expect(
    screen.getByText("Returned for review").compareDocumentPosition(question) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.getByText("run:42").closest(".brief-section")?.querySelector("h3")?.textContent,
  ).toBe("FLIGHT's view");
});

it.each([undefined, "", "   "])(
  "falls back from an empty ask (%s) to the recommendation",
  (ask) => {
    render(<ItemBrief brief={brief({ ask, recommendation: "Use the fallback" })} />);
    expect(screen.getByText("Use the fallback")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What FLIGHT needs from you" })).toBeTruthy();
  },
);

it("omits an empty ask and does not repeat the recommended option's text", () => {
  render(
    <>
      <ItemBrief brief={brief({ ask: "   ", recommendation: " " })} />
      <BriefOptions
        options={[{ id: "a", label: "Proceed", answer: "Use this answer" }]}
        recommendedOptionId="a"
        recommendation="Use this answer"
        live
        disabled={false}
        variant="panel"
        onPick={() => {}}
      />
    </>,
  );
  expect(screen.queryByRole("heading", { name: "What FLIGHT needs from you" })).toBeNull();
  expect(screen.getAllByText("Use this answer")).toHaveLength(1);
  expect(screen.getByText("FLIGHT recommends")).toBeTruthy();
});
