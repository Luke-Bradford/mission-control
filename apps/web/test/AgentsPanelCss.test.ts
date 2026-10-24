import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
it("keeps narrow agent cells shrinkable, folds progress and metadata, and aligns nested runs", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(
    /#agentsList \.trow \{\s*grid-template-columns: minmax\(0, 1fr\)\s+minmax\(0, 1fr\)/,
  );
  expect(phone).toMatch(
    /#agentsList \.agent-activity,\s*#agentsList \.agent-metadata \{\s*display: none/,
  );
  expect(phone).toMatch(/#agentsList \.asideline > :nth-child\(3\),[^}]*grid-column: 1 \/ -1/);
  expect(css).toMatch(/\.trow \.asideline \{[^}]*grid-template-columns: subgrid/);
  expect(css).toMatch(/\.trow > \*,\s*\.trow \.asideline > \* \{\s*min-width: 0/);
});

it("hides the column headers and empty set-aside context cell on phones", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/#agentsList \.trow\.head[^{]*\{\s*display: none/);
  expect(phone).toMatch(/#agentsList \.asideline > :nth-child\(6\)[^{]*\{\s*display: none/);
});

it("gives quota windows full-width readable meters", () => {
  const layout = css.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
  expect(layout).toMatch(/\.quotarow \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  expect(layout).toMatch(
    /\.quota-window \.meter \{[^}]*grid-template-columns: 64px minmax\(0, 1fr\)/,
  );
});
