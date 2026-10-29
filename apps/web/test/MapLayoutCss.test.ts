import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/map/map.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`${selector} \\{([^}]+)\\}`))?.[1] ?? "";

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((i) => {
    const value = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
};
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const token = (name: string): string => {
  const colour = new RegExp(`${name}: (#[0-9a-f]{6})`, "i").exec(css)?.[1];
  if (!colour) throw new Error(`Missing ${name}`);
  return colour;
};

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
    expect(rule(`\\.map-key-steps \\.map-key-swatch-${step}`)).toContain("opacity: 1");
  }
});

it("lets the step swatch rules outrank the generic key-icon background", () => {
  for (const step of [1, 2, 3, 4]) {
    const body = rule(`\\.map-key-steps \\.map-key-swatch-${step}`);
    expect(body).toContain(`background: var(--map-key-swatch-${step})`);
  }
  // `.map-legend i` / `.map-analytical-key i` is (0,1,1); a bare `.map-key-swatch-N` is (0,1,0) and loses.
  expect(css).not.toMatch(/^\.map-key-swatch-\d \{/m);
});

it("scopes the Ownership, Review and Conflicts key swatches under the key so the generic icon rule cannot win", () => {
  for (const name of [
    "map-key-area",
    "map-key-hatch",
    "map-key-conflict",
    "map-severity-critical",
  ]) {
    expect(css, name).toMatch(new RegExp(`^\\.map-analytical-key \\.${name}[,{ ]`, "m"));
    expect(css, name).not.toMatch(new RegExp(`^\\.${name} \\{`, "m"));
  }
  expect(rule(String.raw`\.map-analytical-key \.map-key-area`)).toContain("var(--map-key-area)");
});

it("gives each key's four step swatches four distinct colours", () => {
  const seat1 = token("--seat-1");
  for (const block of [String.raw`\.map-key-steps`, String.raw`\.map-key-steps-impact`]) {
    const colours = [1, 2, 3, 4].map((step) => {
      const value = new RegExp(`--map-key-swatch-${step}: ([^;]+);`).exec(rule(block))?.[1];
      if (!value) throw new Error(`Missing step ${step} in ${block}`);
      return value === "var(--seat-1)" ? seat1 : value;
    });
    expect(new Set(colours).size, block).toBe(4);
  }
});

it("keeps each Impact seat chip's custom colour above the shared key-icon rule", () => {
  expect(rule(String.raw`\.map-key-seat-chip i`)).toContain("background: var(--map-key-seat)");
  expect(css.indexOf(".map-key-seat-chip i")).toBeGreaterThan(css.indexOf(".map-analytical-key i"));
});

it("keeps every seat and analytical-key swatch at non-text contrast in its theme", () => {
  const dark = "#070a0e";
  const light = "#f3f5f8";
  const keySwatches = [...css.matchAll(/--map-key-swatch-\d: (#[0-9a-f]{6})/gi)].map(
    (match) => match[1] as string,
  );
  for (const name of [
    "--seat-1",
    "--seat-2",
    "--seat-3",
    "--seat-4",
    "--seat-5",
    "--seat-6",
    "--seat-7",
    "--seat-flight",
  ]) {
    expect(contrast(token(name), dark), name).toBeGreaterThanOrEqual(3);
    expect(contrast(token(name), light), name).toBeGreaterThanOrEqual(3);
  }
  expect(keySwatches).toHaveLength(15);
  for (const colour of keySwatches.slice(0, 4)) {
    expect(contrast(colour, dark), colour).toBeGreaterThanOrEqual(3);
  }
  for (const colour of keySwatches.slice(4, 7)) {
    expect(contrast(colour, dark), colour).toBeGreaterThanOrEqual(3);
    expect(contrast(colour, light), colour).toBeGreaterThanOrEqual(3);
  }
  for (const colour of keySwatches.slice(7)) {
    expect(contrast(colour, light), colour).toBeGreaterThanOrEqual(3);
  }
});
