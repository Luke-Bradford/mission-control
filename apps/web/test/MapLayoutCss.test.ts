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
const hudCss = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
/** A palette token's hex: the seats' are the HUD's (hud.css), FLIGHT's tone on the void is the map's. */
const token = (name: string): string => {
  const colour = new RegExp(`${name}: (#[0-9a-f]{6})`, "i").exec(
    name.startsWith("--seat-") && name !== "--seat-flight" ? hudCss : css,
  )?.[1];
  if (!colour) throw new Error(`Missing ${name}`);
  return colour;
};

it("reserves auto rows for the key bar and deck around the flexible map row", () => {
  expect(rule(String.raw`\.map-body`)).toContain("grid-template-rows: auto minmax(0, 1fr) auto");
});

/** The declarations of the rule whose selector list holds exactly this selector. */
const listed = (selector: string) => {
  for (const [, list, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (
      (list as string)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .some((item) => item.trim() === selector)
    )
      return body as string;
  return "";
};

it("keeps the Map's rail one width, with no lens rails", () => {
  expect(rule(String.raw`\.map-main`)).toContain("300px");
  expect(css).not.toMatch(/\.map-main-/);
});

it("draws a conflicting tile with a flat outline, no overlay, glow or fade", () => {
  const body = listed(".map-treemap-tile[data-conflict]");
  expect(body).toContain("outline: 2px solid var(--rem)");
  expect(body).not.toMatch(/opacity|shadow|gradient/);
  expect(css).not.toContain("[data-conflict]::before");
  expect(css).not.toContain("map-treemap-conflicts");
});

it("keeps the lens panels' rules out of the Map's stylesheet", () => {
  for (const lensRule of [".map-lens", ".map-severity", ".map-pr", ".map-analytical-key"])
    expect(css, lensRule).not.toContain(lensRule);
});

it("keeps the Changes key swatches in the seat colour, four steps", () => {
  for (const step of [1, 2, 3, 4])
    expect(rule(`\\.map-key-steps-changes \\.map-key-swatch-${step}`)).toContain("opacity");
});

it("keeps every seat colour at non-text contrast in its theme", () => {
  const dark = "#070a0e";
  const light = "#f3f5f8";
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
});
