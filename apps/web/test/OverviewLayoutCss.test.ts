import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Overview layout (hud.css)", () => {
  it("caps content-sized rows and gives unused height to the Live log", () => {
    expect(rule(String.raw`\.overview-grid`)).toContain("flex: 1");
    expect(rule(String.raw`\.overview-grid`)).toContain("min-height: 0");
    expect(rule(String.raw`\.overview-grid`)).toContain(
      "grid-template-rows: auto fit-content(45%) fit-content(18%) minmax(0, 1fr)",
    );
    expect(rule(String.raw`\.overview-work`)).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(260px, 28%)",
    );
    expect(rule(String.raw`\.ov`)).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(300px, 28%)",
    );
    expect(rule("#agentsList")).toContain("overflow-y: auto");
    expect(rule("#agentsList")).toContain("overflow-x: hidden");
    expect(rule(String.raw`\.scroll`)).toContain("min-height: 0");
    expect(rule(String.raw`\.scroll`)).toContain("overflow: auto");
    expect(rule(String.raw`\.ov > \.col > \.panel > \.pb`)).toContain("overflow: auto");
  });

  it("keeps eight full-width graphs and five compact Pipeline lanes at dock widths", () => {
    expect(rule(String.raw`\.overview-kpis`)).toContain("repeat(8, minmax(0, 1fr))");
    expect(rule(String.raw`\.overview-kpis`)).toContain("gap: 12px");
    expect(rule(String.raw`\.overview-kpi .spark`)).toContain("width: 100%");
    expect(rule(String.raw`\.overview-kpi .spark`)).toContain("height: 26px");
    expect(rule(String.raw`\.overview-lane`)).toContain("height: 100%");
    expect(rule(String.raw`\.pipeline-grid`)).toContain("repeat(5, minmax(0, 1fr))");
    expect(rule(String.raw`\.pipeline-chip`)).toContain("align-items: center");
    expect(css).not.toContain("@container overview (width < 1100px)");
    expect(rule(String.raw`#agentsList \.trow`)).toContain("min-width: 0");
    expect(rule(String.raw`#machP \.resrow \.spark`)).toContain("width: 100%");
  });

  it("shares available Timeline height equally between lanes within 14–28px", () => {
    const lanes = rule(String.raw`\.overview-lanes`);
    expect(lanes).toContain("--lane-min: 14px");
    expect(lanes).toContain("--lane-max: 28px");
    expect(lanes).toContain("repeat(var(--lane-count), minmax(var(--lane-min), 1fr))");
    expect(lanes).toContain("min-height: calc(var(--lane-count) * var(--lane-min))");
    expect(lanes).toContain("max-height: calc(var(--lane-count) * var(--lane-max))");
    expect(rule(String.raw`\.timeline-body`)).toContain("flex-direction: column");
    expect(rule("#timelineP")).toContain("align-self: start");
    expect(rule(String.raw`\.overview-track`)).toContain("height: 100%");
    expect(rule(String.raw`\.overview-span`)).toContain("bottom: 3px");
  });

  it("aligns Machine labels, fixed-height charts and values on shared columns", () => {
    const row = rule("#machP .resrow");
    expect(row).toContain("grid-template-columns: 42px minmax(24px, 1fr) 128px");
    expect(row).toContain("align-items: center");
    expect(rule("#machP .machine-chart")).toContain("height: 24px");
    expect(rule("#machP .ph")).toContain("flex-wrap: nowrap");
    expect(rule("#timelineP .ph")).toContain("flex-wrap: nowrap");
  });

  it("wraps KPI labels without ellipses and keeps eight Crew rows below the 45% cap", () => {
    const label = rule(String.raw`\.overview-kpi .lbl`);
    expect(label).toContain("font-size: 10px");
    expect(label).toContain("white-space: normal");
    expect(label).not.toContain("ellipsis");
    const row = rule(String.raw`#agentsList \.trow`);
    const height = Number(row.match(/height: (\d+)px/)?.[1]);
    expect(height).toBeLessThanOrEqual(40);
    // Reserve 160px for shell chrome at 1440×900, plus 56px for Crew's title and columns.
    expect(8 * height + 56).toBeLessThanOrEqual((900 - 160) * 0.45);
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

it("scrolls the pipeline inside its capped row instead of cutting cards off", () => {
  expect(css).toMatch(/#pipelineP > \.pipeline-grid \{[^}]*min-height: 0;[^}]*overflow-y: auto/);
});
