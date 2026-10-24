import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
it("sizes Agents to its rows and gives Activity the remaining height", () => {
  expect(css).toMatch(/#page-overview > #agentsP \{\s*flex: none/);
  expect(css).toMatch(/#agentsList \{\s*overflow: visible/);
  expect(css).toMatch(/\.ov > \.col \{\s*overflow: visible/);
  expect(css).toMatch(/\.ov > #actP \{\s*min-height: 240px;\s*align-self: stretch/);
  expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\) 300px/);
  expect(css).not.toContain("min-height: calc(100dvh - 130px)");
  expect(css).not.toContain("#agentsP .scroll");
});

it("keeps all metrics on one padded line and only needs on line two", () => {
  expect(css).toMatch(/\.trow \{[^}]*padding: 8px 10px/);
  expect(css).toMatch(/\.trow:not\(\.head\) \{\s*grid-template-rows: 20px/);
  expect(css).toMatch(/#agentsList \.trow > \* \{\s*grid-row: 1/);
  expect(css).toMatch(/#agentsList \.trow > \.need \{[^}]*grid-row: 2;[^}]*height: 20px/);
  expect(css).toMatch(/#agentsList\.no-steps \.loopstep \{\s*display: none/);
  expect(css).not.toMatch(/#agentsList \.agent-activity \.spark \{[^}]*display: none/);
  expect(css).toContain("animation: activity-pulse");
  expect(css).toContain("prefers-reduced-motion: reduce");
});

it("shrinks state pills independently of their age without overflowing the grid", () => {
  expect(css).toMatch(/\.state-cell \.pill \{[^}]*min-width: 0;[^}]*overflow: hidden/);
  expect(css).toMatch(/\.state-cell > \.xs \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell \.pill > span \{[^}]*text-overflow: ellipsis/);
  expect(css).not.toMatch(/\.trow \{[^}]*grid-template-columns:[^;]* 84px /);
});

it("compacts by panel width and stacks only below 1100 viewport pixels", () => {
  expect(css).not.toMatch(/#agentsList[^{}]*\.trow\s*\{[^}]*min-width: (?:960|1010)px/);
  const compact = css.slice(
    css.indexOf("@container agents (width < 1360px)"),
    css.indexOf(".activity-live {"),
  );
  expect(compact).toMatch(/\.agent-cli\s*\{\s*display: none/);
  expect(compact).toMatch(/\.spark\s*\{\s*width: 24px/);
  expect(compact.match(/105px minmax\(0, 1fr\)/g)).toHaveLength(2);
  const stacked = css.slice(
    css.indexOf("@media (width < 1100px)"),
    css.indexOf("/* Summary disclosures"),
  );
  expect(stacked).toContain("#agentsList.no-steps .trow");
  expect(stacked).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
  expect(stacked).toMatch(/\.trow.head\s*\{\s*display: none/);
  expect(stacked).toContain("grid-row: auto");
});
