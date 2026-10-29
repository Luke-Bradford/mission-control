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
  expect(rule(String.raw`\.map-main-impact`)).toContain(
    "grid-template-columns: minmax(0, 1fr) clamp(360px, 27vw, 432px)",
  );
  expect(rule(String.raw`\.map-main-history`)).toContain(
    "grid-template-columns: minmax(0, 1fr) clamp(360px, 27vw, 432px)",
  );
});

it("draws focused direct imports with the v3 dashed relationship outline", () => {
  expect(rule(String.raw`\.map-treemap-impact \.map-treemap-tile\[data-direct-import\]`)).toContain(
    "dashed",
  );
});

it("keeps analytical keys in the toolbar without changing the Changes stage layout", () => {
  expect(rule(String.raw`\.map-stage-wrap`)).not.toContain("grid-template-rows");
  expect(rule(String.raw`\.map-analytical-key`)).toContain("display: flex");
});

it("keeps every analytical scale swatch opaque against either theme's page background", () => {
  for (const step of [1, 2, 3, 4]) {
    expect(rule(`\\.map-key-swatch-${step}`)).toContain("opacity: 1");
  }
});

it("keeps each Impact seat chip's custom colour above the shared key-icon rule", () => {
  expect(rule(String.raw`\.map-key-seat-chip i`)).toContain("background: var(--map-key-seat)");
  expect(css.indexOf(".map-key-seat-chip i")).toBeGreaterThan(css.indexOf(".map-analytical-key i"));
});
