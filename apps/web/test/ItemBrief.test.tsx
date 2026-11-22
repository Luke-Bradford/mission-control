import type { BriefBinding } from "@mc/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIEF_LINES, BriefOptions, DecisionFacts, ItemBrief } from "../src/comms/ItemBrief.tsx";
import { boundBrief, brief, NOW } from "./fixtures.ts";
import { readStyles } from "./styles.ts";

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

it("omits catch-up sections when the hub has no catch-up data", () => {
  render(<ItemBrief brief={brief({ catchUp: undefined })} />);
  expect(screen.queryByText("Catch-up unavailable.")).toBeNull();
  expect(screen.queryByText("Awareness unavailable.")).toBeNull();
  expect(screen.queryByText("So far")).toBeNull();
  expect(screen.queryByText("Be aware")).toBeNull();
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
  const css = readStyles();
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

describe("DecisionFacts", () => {
  const opts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `o${i}`,
      label: `Option ${i}`,
      answer: `Answer ${i}`,
    }));

  it.each([2, 4])("renders complete decision facts with %i options", (n) => {
    const b = boundBrief({
      options: opts(n),
      decision: {
        whyOperator: { kind: "money", explanation: "It spends budget." },
        consulted: [],
        costOfDelay: "Nothing ships until you answer.",
      },
    });
    render(
      <>
        <DecisionFacts brief={b} tz="UTC" />
        <BriefOptions
          options={b.options}
          recommendedOptionId="o1"
          live={false}
          disabled={false}
          variant="panel"
          onPick={() => {}}
        />
      </>,
    );
    for (const h of [
      "Why it needs you",
      "Who FLIGHT consulted",
      "If nobody answers",
      "Cost of delay",
    ])
      expect(screen.getByRole("heading", { name: h })).toBeTruthy();
    expect(screen.getByText("Nobody consulted")).toBeTruthy();
    expect(screen.getByText("Money.")).toBeTruthy();
    expect(screen.getByText("Nothing ships until you answer.")).toBeTruthy();
    for (const o of b.options) expect(screen.getByText(`Consequence of ${o.label}.`)).toBeTruthy();
    expect(screen.getAllByText("Can be undone.")).toHaveLength(n);
    const rec = document.querySelectorAll(".opt.rec");
    expect(rec).toHaveLength(1);
    expect(rec[0].textContent).toContain("Option 1");
  });

  it("legacy brief shows Needs a refreshed brief", () => {
    const legacy = brief({
      state: {
        completeness: "incomplete",
        freshness: "unknown",
        reason: "Written before briefs were bound.",
      },
    });
    render(<DecisionFacts brief={legacy} tz="UTC" />);
    expect(screen.getByText("Needs a refreshed brief")).toBeTruthy();
    expect(screen.getByText(/Written before briefs were bound/)).toBeTruthy();
    expect(screen.queryByText("Why it needs you")).toBeNull();
    expect(screen.queryByText("Cost of delay")).toBeNull();
  });

  it("shows a stale badge with the reason", () => {
    render(
      <DecisionFacts
        brief={boundBrief({
          state: { completeness: "complete", freshness: "stale", reason: "The head moved." },
        })}
        tz="UTC"
      />,
    );
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/The head moved\./)).toBeTruthy();
  });

  it("countdown only for FYI", () => {
    const effect = "Within-authority guidance delivered to the displayed run";
    const base = boundBrief();
    const fyi = boundBrief({
      decision: { consulted: [], costOfDelay: "Slower." },
      binding: {
        ...(base.binding as BriefBinding),
        actions: (base.binding as BriefBinding).actions.map((a) => ({ ...a, effect })),
      },
    });
    const { unmount } = render(
      <DecisionFacts brief={fyi} defaultDueAt={Date.UTC(2026, 9, 17, 14, 40)} tz="UTC" />,
    );
    expect(
      screen.getByText(`FLIGHT will ${effect} at 14:40 unless you choose.`, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText("Within FLIGHT's standing authority")).toBeTruthy();
    unmount();
    render(<DecisionFacts brief={boundBrief()} defaultDueAt={NOW} tz="UTC" />);
    expect(
      screen.getByText(/Waits for your answer\. Nothing happens automatically\./),
    ).toBeTruthy();
    expect(screen.queryByText(/applies its recommendation/)).toBeNull();
  });

  it("ticks only the FYI deadline clock and settles at its deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const base = boundBrief();
    const fyi = boundBrief({
      decision: { consulted: [], costOfDelay: "Slower." },
      binding: {
        ...(base.binding as BriefBinding),
        actions: (base.binding as BriefBinding).actions.map((a) => ({
          ...a,
          effect: "Guidance delivered",
        })),
      },
    });
    render(<DecisionFacts brief={fyi} defaultDueAt={NOW + 90_000} tz="UTC" />);
    expect(screen.getByText(/1:30 remaining/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/1:29 remaining/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(89_000));
    expect(screen.getByText(/Deadline reached/)).toBeTruthy();
    vi.useRealTimers();
  });
});
