import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Overview layout (hud.css)", () => {
  it("keeps the banner, KPIs, crew and pipeline at content height so main scrolls", () => {
    expect(rule(String.raw`#page-overview > \*`)).toContain("flex-shrink: 0");
    expect(rule(String.raw`\.overview-crew`)).toContain("flex: none");
    expect(css).toMatch(/main \{[^}]*overflow: auto/);
  });

  it("fills remaining height with a 420px minimum and bounds Activity with an inner scroll", () => {
    const grid = rule(String.raw`\.ov`);
    expect(grid).toContain("flex: 1 0 0");
    expect(grid).toContain("min-height: 420px");
    expect(grid).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(grid).toContain("align-items: start");
    expect(rule(String.raw`\.ov > #actP`)).toContain("min-height: 240px");
    expect(rule(String.raw`\.ov > #actP`)).toContain("align-self: stretch");
    expect(rule(String.raw`\.ov > #actP`)).toContain("overflow: hidden");
    expect(rule(String.raw`\.panel`)).toContain("display: flex");
    expect(rule(String.raw`\.panel`)).toContain("flex-direction: column");
    expect(rule(String.raw`\.scroll`)).toContain("min-height: 0");
    expect(rule(String.raw`\.scroll`)).toContain("overflow: auto");
    expect(rule(String.raw`\.panel > \.pb.scroll`)).toContain("flex: 1 1 auto");
    expect(rule(String.raw`\.col > \.panel`)).toContain("flex: none");
  });

  it("fits every measured header control at 1440px while keeping narrow wrapping", () => {
    const desktop = css.match(/@media \(min-width: 1200px\) \{\s*\.top \{([^}]*)\}/)?.[1] ?? "";
    const gap = Number(desktop.match(/gap: 8px (\d+)px/)?.[1]);
    expect(gap).toBeGreaterThan(0);
    const controls = [145, 132, 443, 56, 35, 201, 115, 90, 32, 32, 32];
    // Twelve gaps include the spacer; the app has 16px padding on either side.
    expect(controls.reduce((sum, width) => sum + width, 0) + 12 * gap + 32).toBeLessThanOrEqual(
      1440,
    );
    expect(rule(String.raw`\.top`)).toContain("flex-wrap: wrap");
    expect(rule(String.raw`\.top`)).toContain("gap: 8px 10px");
    expect(desktop).not.toContain("display: none");
  });
});
