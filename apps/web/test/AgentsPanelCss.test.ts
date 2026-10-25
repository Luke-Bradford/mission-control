import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
it("bounds the Overview rows and lets panel bodies scroll internally", () => {
  expect(css).toMatch(
    /\.overview-grid \{[^}]*grid-template-rows: auto fit-content\(45%\) fit-content\(18%\) minmax\(0, 1fr\)/,
  );
  expect(css).toMatch(/#agentsList \{\s*min-height: 0;\s*overflow-y: auto/);
  expect(css).toMatch(
    /\.ov > \.col \{[^}]*grid-template-rows: repeat\(2, fit-content\(calc\(50% - 6px\)\)\);[^}]*overflow: hidden/,
  );
  expect(css).toMatch(/\.overview-grid > \*,[\s\S]*?\.ov > \.panel \{[\s\S]*?overflow: hidden/);
  expect(css).toMatch(/\.ov > \.col > \.panel > \.pb \{\s*min-height: 0;\s*overflow: auto/);
  expect(css).toMatch(/\.panel > \.pb\.scroll \{\s*flex: 1 1 auto/);
});

it("keeps eight compact columns with needs on the second Work line", () => {
  expect(css).toMatch(
    /#agentsList \.trow \{[^}]*padding: 2px 8px;[^}]*grid-template-rows: minmax\(0, 1fr\)/,
  );
  expect(css).toMatch(/#agentsList \.trow > \* \{\s*grid-row: 1/);
  expect(css).toMatch(/#agentsList \.need \{[^}]*font-size: 11px/);
  expect(css).toMatch(/#agentsList \.agent-model \{[^}]*white-space: nowrap/);
  expect(css).not.toContain("#agentsList.no-steps");
  expect(css).toContain("animation: activity-pulse");
  expect(css).toContain("prefers-reduced-motion: reduce");
});

it("keeps State pills and their age from shrinking", () => {
  expect(css).toMatch(/#agentsList \.state-cell \.pill \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell > \.xs \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell \.pill > span \{[^}]*text-overflow: ellipsis/);
});

it("drops token graphs before tightening columns with FLIGHT open", () => {
  expect(css).toMatch(/#agentsList \.trow\s*\{[^}]*min-width: 0/);
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
  expect(narrow).toMatch(/#agentsList \.trow \{[^}]*min-width: 680px/);
  expect(narrow).toMatch(
    /#agentsList \.trow > :first-child \{[^}]*position: sticky;[^}]*left: 0;[^}]*z-index: 1;[^}]*background: var\(--surface\)/,
  );
  // The FLIGHT tint is translucent, so an opaque surface must be the last background layer.
  expect(narrow).toMatch(/#agentsList \.trow\.flight > :first-child \{[^}]*\),\s*var\(--surface\);/);
  expect(narrow).toMatch(
    /#agentsList \.trow:not\(\.head\):hover > :first-child,\s*#agentsList \.trow\.sel > :first-child \{[^}]*background: var\(--surface-2\)/,
  );
});
