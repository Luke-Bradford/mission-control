import { expect, it } from "vitest";
import { readStyles } from "./styles.ts";

const css = readStyles();
it("bounds the Overview rows and lets panel bodies scroll internally", () => {
  expect(css).toMatch(
    /\.overview-grid \{[^}]*grid-template-rows: max-content max-content max-content/,
  );
  expect(css).toMatch(/#agentsList \{\s*min-height: 0;\s*overflow-y: auto/);
  // Source-independent columns keep the bounded Live log ahead of the lower allowance table.
  expect(css).toMatch(/\.ov > \.col \{\s*display: contents/);
  expect(css).toMatch(/\.overview-grid > \*,[\s\S]*?\.ov > \.panel \{[\s\S]*?overflow: hidden/);
  expect(css).toMatch(/\.ov > \.col > \.panel > \.pb \{\s*min-height: 0;\s*overflow: auto/);
  expect(css).toMatch(/\.panel > \.pb\.scroll \{\s*flex: 1 1 auto/);
});

it("keeps seven compact columns and preserves inline needs controls", () => {
  expect(css).toMatch(
    /#agentsList \.trow \{[^}]*padding: 0 var\(--sp-2\);[^}]*grid-template-rows: minmax\(0, 1fr\)/,
  );
  expect(css).toMatch(/#agentsList \.trow > \* \{\s*grid-row: 1/);
  expect(css).toMatch(
    /#agentsList \.agent-identity,\s*#agentsList \.state-cell,\s*#agentsList \.ticket-cell \{[^}]*flex-direction: row/,
  );
  expect(css).toMatch(/#agentsList \.need \{[^}]*font-size: var\(--fs-s\)/);
  expect(css).toMatch(/#agentsList \.agent-model \{[^}]*white-space: nowrap/);
  expect(css).not.toContain("#agentsList.no-steps");
  expect(css).toContain("animation: activity-pulse");
  expect(css).toContain("prefers-reduced-motion: reduce");
});

it("gives the Work track the free width and clips its free text", () => {
  expect(css).toMatch(
    /#agentsList \.trow \{[^}]*grid-template-columns: 128px 80px minmax\(260px, 1fr\) 96px 64px 178px 52px/,
  );
  expect(css).toMatch(/#agentsList \.ticket-cell \{[^}]*overflow: hidden/);
});

it("keeps State pills and their age from shrinking", () => {
  expect(css).toMatch(/#agentsList \.state-cell \.pill \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell > \.xs \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell \.pill > span \{[^}]*text-overflow: ellipsis/);
});

it("drops token graphs before tightening columns with FLIGHT open", () => {
  expect(css).toMatch(/#agentsList \.trow\s*\{[^}]*min-width: 1050px/);
  expect(css).toContain("@container agents (width < 1000px)");
  expect(css).toContain("@container agents (width < 900px)");
  expect(css).toMatch(
    /#agentsList \.agent-activity \.spark \{\s*display: block;[^}]*width: 100%;[^}]*height: 22px/,
  );
  expect(css).toMatch(/#agentsList \.loopstep > \.stepbar \{\s*width: 100%/);
});

it("gives the live log an identity column beside the message and references", () => {
  expect(css).toMatch(
    /#actList \.arow \{\s*grid-template-columns: 44px 14px 110px minmax\(0, 1fr\) auto/,
  );
  expect(css).toMatch(/#actList \.log-who \{\s*font-weight: 600/);
  expect(css).toMatch(/#actList \.arow > \.expandable \{\s*display: block/);
});

it("keeps charts aligned when the live dot or rate text changes", () => {
  expect(css).toMatch(
    /#agentsList \.agent-activity \{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--rate-width\);[^}]*height: 22px/,
  );
  expect(css).toMatch(/#agentsList \.activity-live \{[^}]*position: absolute/);
  expect(css).toMatch(/#agentsList \.agent-activity > span \{[^}]*grid-column: 2/);
  expect(css).toMatch(
    /#agentsList \.loopstep > \.stepbar \{[^}]*grid-auto-columns: minmax\(0, 1fr\)/,
  );
});

it("lets phone users scroll every Crew column while keeping the agent pinned", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(narrow).toMatch(/#agentsList \{[^}]*max-width: 100%;[^}]*overflow-x: auto/);
  expect(narrow).toMatch(/#agentsList \.trow \{[^}]*min-width: 1050px/);
  expect(narrow).toMatch(
    /#agentsList \.trow > :first-child \{[^}]*position: sticky;[^}]*left: 0;[^}]*z-index: 1;[^}]*background: var\(--surface\)/,
  );
  // The FLIGHT tint is translucent, so an opaque surface must be the last background layer.
  expect(narrow).toMatch(
    /#agentsList \.trow\.flight > :first-child \{[^}]*\),\s*var\(--surface\);/,
  );
  expect(narrow).toMatch(
    /#agentsList \.trow:not\(\.head\):hover > :first-child,\s*#agentsList \.trow\.sel > :first-child \{[^}]*background: var\(--surface-2\)/,
  );
});

it("constrains the crew pause modal to the viewport, scrolling its body", () => {
  // the modal sits on the shared overlay: a fixed backdrop, and a panel capped at 86% of the viewport
  expect(css).toMatch(/\.modal \{[^}]*position: fixed/);
  expect(css).toMatch(/\.modal \.panel \{[^}]*max-height: calc\(86 \* var\(--vh\)\)/);
  expect(css).toMatch(/\.crew-pause-panel\.crew-pause-panel \{[^}]*width: min\(640px, 100%\)/);
  // the body is the scroller (`.scroll`), so the footer's actions stay in view
  expect(css).toMatch(/\.scroll \{[^}]*overflow: auto/);
});

it("sizes the review-waiver menu from spacing tokens", () => {
  expect(css).toMatch(/\.waive-compact > select \{[^}]*min-height: var\(--sp-5\)/);
});

it("grows Crew columns with the text, scrolls them sideways and holds State and Seat", () => {
  // Each track is its accepted pixel width or the same width in em, so normal text keeps the pixels.
  expect(css).toMatch(
    /#agentsList \.trow \{[^}]*grid-template-columns:\s*var\(--crew-state-w\) max\(168px, 12\.9em\)\s*minmax\(max\(0px, calc\(\(1em - 13px\) \* 16\)\), 1fr\)\s*max\(104px, 7\.9em\) max\(168px, 12\.9em\) max\(44px, 3\.3em\) max\(40px, 3em\) max\(48px, 3\.6em\)/,
  );
  expect(css).toMatch(/--crew-state-w: max\(88px, 6\.7em\)/);
  expect(css).toMatch(
    /#agentsList \.trow \{[^}]*font-size: var\(--fs\);[^}]*min-width: min-content/,
  );
  expect(css).toMatch(/#agentsList \{\s*overflow-x: auto/);
  expect(css).toMatch(/#agentsList \.trow\.head \{\s*height: auto/);
  expect(css).toMatch(/#agentsList \.state-cell \.pill > span \{\s*overflow: visible/);
  expect(css).toMatch(
    /#agentsList \.trow > :first-child,\s*#agentsList \.trow > :nth-child\(2\) \{\s*position: sticky/,
  );
});

it("keeps the accepted scrollbar gutter, holds cells over their whole row, and keeps the FLIGHT tint", () => {
  const from = css.indexOf("/* Crew under enlarged text.");
  const block = css.slice(from, css.indexOf("The seat stays beside its State.", from) + 200);
  expect(block).not.toContain("scrollbar-gutter");
  expect(block).toMatch(/align-self: stretch/);
  expect(block).toMatch(
    /#agentsList \.trow > :first-child \{\s*left: 0;\s*margin-left: calc\(-1 \* var\(--sp-3\)\)/,
  );
  expect(block).toMatch(
    /#agentsList \.trow\.flight > :first-child,[^{]*\{[^}]*color-mix\(in srgb, var\(--accent-soft\) 45%, transparent\)/,
  );
  expect(block).toMatch(/#agentsList \.trow\.needs::before,[^{]*\{\s*z-index: 2/);
});

it("centres the held headings and loading bars like the other columns", () => {
  expect(css).toMatch(
    /#agentsList \.trow\.head > :first-child,\s*#agentsList \.trow\.head > :nth-child\(2\),\s*#agentsList \.crew-skeleton > :first-child,\s*#agentsList \.crew-skeleton > :nth-child\(2\) \{\s*display: flex;\s*flex-direction: column;\s*justify-content: center/,
  );
});
