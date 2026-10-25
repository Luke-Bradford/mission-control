import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("uses source text and context for legacy briefs", () => {
    render(<ItemBrief original="Source question" brief={brief()} />);
    for (const text of [
      "Source question",
      "The dev seat asks which port to preview on.",
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
      <div className="item-body">
        <ItemBrief original="Question stays above" brief={brief({ assessment })} />
      </div>,
    );
    const body = container.querySelector(".item-body") as HTMLElement;
    body.scrollTop = 80;
    const content = screen
      .getByText(/Assessment line 30/)
      .closest(".expandable-content") as HTMLElement;
    expect(content.style.webkitLineClamp).toBe(String(BRIEF_LINES));
    fireEvent.click(screen.getByRole("button", { name: "Show more, FLIGHT's view" }));
    expect(content.style.webkitLineClamp).toBe("unset");
    expect(content.textContent).toContain(assessment);
    expect(body.scrollTop).toBe(80);
    fireEvent.click(screen.getByRole("button", { name: "Show less, FLIGHT's view" }));
    expect(content.style.webkitLineClamp).toBe(String(BRIEF_LINES));
    expect(body.scrollTop).toBe(80);
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
  "omits an empty ask (%s) instead of repeating the recommendation",
  (ask) => {
    render(<ItemBrief brief={brief({ ask, recommendation: "Use the fallback" })} />);
    expect(screen.queryByText("Use the fallback")).toBeNull();
    expect(screen.queryByRole("heading", { name: "What FLIGHT needs from you" })).toBeNull();
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

it("applies phone wrap and fold rules to long question, recommendation and option content", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const declarations = (selector: string) =>
    rules
      .filter((rule) => rule[1]?.split(",").some((part) => part.trim() === selector))
      .map((rule) => rule[2])
      .join("\n");
  const long = "unbroken".repeat(100);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(160);
  const pick = vi.fn();
  const { container } = render(
    <div id="discuss" className="flyout" style={{ width: 375 }}>
      <div className="panel">
        <div className="item-body">
          <ItemBrief brief={brief({ original: long, assessment: long, ask: long })} />
          <div id="dsOpts">
            <BriefOptions
              options={[{ label: "Proceed", answer: long }]}
              recommendation={long}
              live
              disabled={false}
              variant="panel"
              onPick={pick}
            />
            <BriefOptions
              options={[{ label: long, answer: long }]}
              live
              disabled={false}
              variant="row"
              primaryFirst
              onPick={pick}
            />
          </div>
        </div>
      </div>
    </div>,
  );
  expect(declarations(".flyout")).toContain("width: min(540px, 100%)");
  expect(declarations("#discuss .panel")).toContain("overflow: hidden");
  expect(declarations("#discuss .ph")).toContain("flex: none");
  expect(declarations("#discuss .item-body")).toContain("overflow: auto");
  expect(declarations("#discuss .item-body")).toContain("overflow-anchor: none");
  for (const selector of ["#discuss .brief", "#discuss .opt", ".expandable-text"]) {
    expect(container.querySelector(selector)).toBeTruthy();
    expect(declarations(selector)).toContain("overflow-wrap: anywhere");
  }
  for (const content of container.querySelectorAll<HTMLElement>(".expandable-content")) {
    expect(content.style.webkitLineClamp).toBe(String(BRIEF_LINES));
    expect(content.matches(".expandable-text")).toBe(true);
  }
  expect(declarations(".expandable-text")).toContain("overflow: hidden");
  expect(declarations(".expandable-text")).toContain("-webkit-box-orient: vertical");
  expect(declarations("#dsOpts .optlist")).toContain("min-width: 0");
  expect(container.querySelector("#dsOpts .nopts button")?.textContent).toBe(long);
  expect(declarations("#dsOpts .nopts button")).toContain("white-space: normal");
  expect(declarations("#dsOpts .nopts button")).toContain("overflow-wrap: anywhere");
  expect(declarations("#dsOpts .nopts")).toContain("max-width: 100%");
  expect(declarations("#dsForm")).toContain("flex-wrap: wrap");
  expect(declarations("#dsForm input")).toContain("min-width: 0");
  const button = screen.getByRole("button", { name: "Proceed" });
  expect(button.matches(".option-pick")).toBe(true);
  expect(declarations(".opt")).toContain("position: relative");
  expect(declarations(".option-pick::after")).toContain('content: ""');
  expect(declarations(".option-pick::after")).toContain("position: absolute");
  expect(declarations(".option-pick::after")).toContain("inset: 0");
  for (const selector of [".opt .expandable > .sm", ".opt a"]) {
    expect(declarations(selector)).toContain("position: relative");
    expect(declarations(selector)).toContain("z-index: 1");
  }
  expect(declarations(".option-pick")).toContain("width: 100%");
  expect(declarations(".option-pick")).toContain("white-space: normal");
  fireEvent.click(button);
  expect(pick).toHaveBeenCalledTimes(1);
  const fold = screen.getByRole("button", { name: "Show more, Proceed, option 1" });
  expect(button.contains(fold)).toBe(false);
  fireEvent.click(fold);
  expect(pick).toHaveBeenCalledTimes(1);
  const expanded = container.querySelector<HTMLElement>(
    "#discuss .expandable.open .expandable-content",
  );
  expect(expanded?.style.webkitLineClamp).toBe("unset");
  expect(declarations("#discuss .expandable.open .expandable-content")).toContain(
    "max-height: none",
  );
  expect(declarations("#discuss .expandable.open .expandable-content")).toContain(
    "overflow: visible",
  );
  expect(screen.getByRole("button", { name: "Show more, Recommendation" })).toBeTruthy();
});

it("shows the approval recommendation above a labelled call group and all option descriptions", () => {
  render(
    <BriefOptions
      options={[
        {
          id: "approve",
          label: "Approve",
          answer: "Send it",
          description: "Send the reviewed draft",
        },
        { id: "skip", label: "Skip", answer: "Leave the draft unsent" },
      ]}
      recommendedOptionId="approve"
      recommendation="The draft is ready to send"
      live
      disabled={false}
      variant="row"
      rowLabel="Your call:"
      primaryFirst
      onPick={() => {}}
    />,
  );
  const recommendation = screen.getByText("The draft is ready to send");
  const group = screen.getByRole("group", { name: "Your call:" });
  expect(recommendation.closest(".recommendation")?.textContent).toContain("FLIGHT recommends");
  expect(
    recommendation.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(document.querySelector(".opt.rec")?.textContent).toContain("Approve");
  expect(document.querySelector(".opt.rec .qtext")?.getAttribute("aria-hidden")).toBe("true");
  expect(document.querySelector(".opt.rec")?.textContent).toContain("FLIGHT recommends");
  for (const description of ["Send the reviewed draft", "Leave the draft unsent"])
    expect(screen.getByText(description).closest(".opt")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve" }).title).toBe("");
});
