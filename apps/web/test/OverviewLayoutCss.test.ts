import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Overview layout (hud.css)", () => {
  it("bounds the four rows below the banner and shares remaining height equally", () => {
    expect(rule(String.raw`\.overview-grid`)).toContain("flex: 1");
    expect(rule(String.raw`\.overview-grid`)).toContain("min-height: 0");
    expect(rule(String.raw`\.overview-grid`)).toContain(
      "grid-template-rows: auto fit-content(38%) minmax(0, 1fr) minmax(0, 1fr)",
    );
    expect(rule(String.raw`\.overview-work`)).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)",
    );
    expect(rule(String.raw`\.ov`)).toContain("grid-template-columns: minmax(0, 1fr) 320px");
    expect(rule("#agentsList")).toContain("overflow: auto");
    expect(rule(String.raw`\.scroll`)).toContain("min-height: 0");
    expect(rule(String.raw`\.scroll`)).toContain("overflow: auto");
    expect(rule(String.raw`\.ov > \.col > \.panel > \.pb`)).toContain("overflow: auto");
  });

  it("uses compact tiles, timeline lanes and single-line Pipeline cards", () => {
    expect(rule(String.raw`\.overview-kpis`)).toContain("repeat(8, minmax(0, 1fr))");
    expect(rule(String.raw`\.overview-kpi`)).toContain("height: 64px");
    expect(rule(String.raw`\.overview-lane`)).toContain("height: 14px");
    expect(rule(String.raw`\.pipeline-title`)).toContain("white-space: nowrap");
    expect(rule(String.raw`\.pipeline-title`)).toContain("text-overflow: ellipsis");
    expect(css).toMatch(
      /@container overview \(width < 1100px\) \{\s*\.overview-kpis \{\s*grid-template-columns: repeat\(4,/,
    );
    expect(css).toMatch(
      /@container overview \(width < 1100px\) \{\s*\.overview-work \{[^}]*grid-template-rows: minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    );
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
