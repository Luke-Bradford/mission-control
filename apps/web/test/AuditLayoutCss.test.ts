import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";
const phone = css.match(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

it("keeps the populated Audit dashboard readable at desktop and phone widths", () => {
  expect(rule(".audit-grid")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(rule(".audit-grid")).toContain("gap: 10px");
  expect(rule(".audit-panel:last-child")).toContain("grid-column: 1 / -1");
  expect(rule(".audit-list")).toContain("gap: 7px");
  expect(rule(".audit-size,\\n.audit-proposal")).toContain("align-items: center");
  expect(phone).toContain(".audit-grid");
  expect(phone).toContain("grid-template-columns: minmax(0, 1fr)");
});

it("keeps a PR fill independent from its fixed-width track", () => {
  const track = rule(".audit-bar-track");
  const fill = rule(".audit-bar");

  expect(track).toContain("flex: 1");
  expect(track).toContain("min-width: 36px");
  expect(fill).toContain("display: block");
  expect(fill).not.toMatch(/(?:min-)?width:/);
  expect(fill).not.toContain("flex:");
});
