import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/map/map.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`${selector} \\{([^}]+)\\}`))?.[1] ?? "";

it("reserves auto rows for the lens toolbar and deck around the flexible map row", () => {
  expect(rule(String.raw`\.map-body`)).toContain("grid-template-rows: auto minmax(0, 1fr) auto");
});

it("widens only analytical lens rails to the v3 table proportion", () => {
  expect(rule(String.raw`\.map-main`)).toContain("300px");
  expect(css).toContain(".map-main-impact,");
  expect(css).toContain("grid-template-columns: minmax(0, 1fr) clamp(360px, 27vw, 432px)");
});
