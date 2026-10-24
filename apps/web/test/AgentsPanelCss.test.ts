import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
it("caps Agents by its rows and gives the remaining grid rows to the scrolling panels", () => {
  expect(css).toMatch(/\.overview-grid \{[^}]*min-height: 0;[^}]*display: grid/);
  expect(css).toMatch(
    /\.overview-grid \{[^}]*grid-template-rows: auto fit-content\(38%\) minmax\(0, 1fr\) minmax\(0, 1fr\)/,
  );
  expect(css).toMatch(
    /\.overview-kpis \{[^}]*grid-template-columns: repeat\(8, minmax\(0, 1fr\)\)/,
  );
  expect(css).toMatch(
    /\.overview-work \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/,
  );
  expect(css).toMatch(/\.ov \{[^}]*grid-template-columns: minmax\(0, 1fr\) 320px/);
  expect(css).toMatch(/#agentsList \{\s*min-height: 0;\s*overflow: auto/);
  expect(css).toMatch(
    /\.ov > \.col \{[^}]*grid-template-rows: minmax\(0, 1fr\) minmax\(0, 1fr\);[^}]*overflow: hidden/,
  );
  expect(css).toMatch(/\.overview-grid > \*,[\s\S]*?\.ov > \.panel \{[\s\S]*?overflow: hidden/);
  expect(css).toMatch(/\.ov > \.col > \.panel > \.pb \{\s*min-height: 0;\s*overflow: auto/);
  expect(css).toMatch(/\.panel > \.pb\.scroll \{\s*flex: 1 1 auto/);
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

it("keeps State pills and their age from shrinking", () => {
  expect(css).toMatch(/#agentsList \.state-cell \.pill \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell > \.xs \{\s*flex: none/);
  expect(css).toMatch(/\.state-cell \.pill > span \{[^}]*text-overflow: ellipsis/);
  expect(css).not.toMatch(/\.trow \{[^}]*grid-template-columns:[^;]* 84px /);
});

it("compacts and stacks by available panel width", () => {
  expect(css).not.toMatch(/#agentsList[^{}]*\.trow\s*\{[^}]*min-width: (?:960|1010)px/);
  const compact = css.slice(
    css.indexOf("@container agents (width < 1360px)"),
    css.indexOf(".activity-live {"),
  );
  expect(compact).toMatch(/\.agent-cli\s*\{\s*display: none/);
  expect(css).toMatch(/#agentsList \.agent-activity \.spark \{\s*flex: 1;\s*min-width: 40px/);
  expect(compact.match(/140px minmax\(0, 1fr\)/g)).toHaveLength(4);
  const stacked = css.slice(
    css.indexOf("@media (width < 1100px)"),
    css.indexOf("/* Summary disclosures"),
  );
  expect(stacked).toContain("#agentsList.no-steps .trow");
  expect(stacked).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
  expect(stacked).toMatch(/\.trow.head\s*\{\s*display: none/);
  expect(stacked).toContain("grid-row: auto");
});

it("keeps feed tags beside readable text on desktop and preserves the phone grid", () => {
  expect(css).toMatch(
    /@media \(min-width: 761px\) \{\s*\.arow \{\s*grid-template-columns: 44px 16px fit-content\(110ch\) auto;\s*justify-content: start/,
  );
  expect(css).toMatch(/\.arow > \.expandable \{\s*max-width: 110ch/);
  expect(css).toMatch(/#agentsList\.no-quota \.trow > :nth-child\(9\) \{\s*display: none/);
});
