import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStyles } from "./styles.ts";

const css = readStyles();
const main = readFileSync(join(import.meta.dirname, "../src/main.tsx"), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Overview layout (hud.css)", () => {
  it("gives compact Overview and Setup controls a 24px minimum target", () => {
    expect(rule("button")).toContain("min-width: 24px");
    expect(rule("button")).toContain("min-height: 24px");
    expect(rule("select")).toContain("min-width: 24px");
    expect(rule("select")).toContain("min-height: 24px");
    expect(rule(String.raw`#agentsList \.need button`)).toContain("min-height: 24px");
    expect(rule(String.raw`\.repo-pick \.chip button`)).toContain("min-height: 24px");
    expect(rule(String.raw`\.overview-lane`)).toContain("min-height: 24px");
    expect(rule(String.raw`\.overview-lane`)).toContain("margin-block: calc(var(--sp-1) / -2)");
    expect(rule(String.raw`\.trow \.rowlink`)).toContain("min-height: 24px");
  });

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
    expect(rule(String.raw`\.overview-kpis`)).toContain("gap: var(--sp-3)");
    expect(rule(String.raw`\.overview-kpi .spark`)).toContain("width: 100%");
    expect(rule(String.raw`\.overview-kpi .spark`)).toContain("height: 24px");
    expect(rule(String.raw`\.overview-lane`)).toContain("height: 100%");
    expect(rule(String.raw`\.pipeline-grid`)).toContain("repeat(5, minmax(0, 1fr))");
    expect(rule(String.raw`\.pipeline-chip`)).toContain("align-items: center");
    expect(css).not.toContain("@container overview (width < 1100px)");
    expect(rule(String.raw`#agentsList \.trow`)).toContain("min-width: 0");
    expect(rule(String.raw`#machP \.resrow \.spark`)).toContain("width: 100%");
  });

  it("shares available Timeline height equally between lanes within 19–28px", () => {
    const lanes = rule(String.raw`\.overview-lanes`);
    expect(lanes).toContain("--lane-min: 19px");
    expect(lanes).toContain("--lane-max: 28px");
    expect(lanes).toContain("repeat(var(--lane-count), minmax(var(--lane-min), 1fr))");
    expect(lanes).toContain("min-height: calc(var(--lane-count) * var(--lane-min))");
    expect(lanes).toContain("max-height: calc(var(--lane-count) * var(--lane-max))");
    expect(rule(String.raw`\.timeline-body`)).toContain("flex-direction: column");
    expect(rule("#timelineP")).toContain("align-self: start");
    expect(rule(String.raw`\.overview-track`)).toContain("height: 100%");
    expect(rule(String.raw`\.overview-span`)).toContain("height: var(--sub)");
    expect(rule(String.raw`\.overview-span\.k-turn`)).toContain("top: calc(50% - var(--sub) / 2)");
  });

  it("keeps all four sub-tracks inside the track at the shortest lane", () => {
    const px = (block: string, name: string) =>
      Number(block.match(new RegExp(`${name}: ([\\d.]+)px`))?.[1]);
    const laneMin = px(rule(String.raw`\.overview-lanes`), "--lane-min");
    const track = rule(String.raw`\.overview-track`);
    const sub = px(track, "--sub");
    const gap = px(track, "--sub-gap");
    const top = (kind: string) =>
      rule(String.raw`\.overview-span\.k-${kind}`).match(/top: calc\((.*)\);/)?.[1] ?? "";
    // The offsets as hud.css writes them, evaluated at the shortest lane (50% = half of it).
    expect(top("turn")).toBe("50% - var(--sub) / 2");
    expect(top("checks")).toBe("50% - 1.5 * var(--sub) - var(--sub-gap)");
    expect(top("review")).toBe("50% - 2.5 * var(--sub) - 2 * var(--sub-gap)");
    expect(top("lock")).toBe("50% + var(--sub) / 2 + var(--sub-gap)");
    const half = laneMin / 2;
    const tops = {
      turn: half - sub / 2,
      checks: half - 1.5 * sub - gap,
      review: half - 2.5 * sub - 2 * gap,
      lock: half + sub / 2 + gap,
    };
    for (const [kind, at] of Object.entries(tops)) {
      expect(at, kind).toBeGreaterThanOrEqual(0);
      expect(at + sub, kind).toBeLessThanOrEqual(laneMin);
    }
  });

  it("aligns Machine labels, fixed-height charts and values on shared columns", () => {
    const row = rule("#machP .resrow");
    expect(row).toContain("grid-template-columns: 42px minmax(24px, 1fr) 128px");
    expect(row).toContain("align-items: center");
    expect(rule("#machP .machine-chart")).toContain("height: 24px");
    expect(rule("#machP .ph")).toContain("flex-wrap: nowrap");
    expect(rule("#timelineP .ph")).toContain("flex-wrap: nowrap");
  });

  it("wraps KPI labels without ellipses and keeps Crew rows to the 40px system row", () => {
    const label = rule(String.raw`\.overview-kpi .lbl`);
    expect(label).toContain("font-size: var(--fs-s)");
    expect(label).toContain("white-space: normal");
    expect(label).not.toContain("ellipsis");
    const row = rule(String.raw`#agentsList \.trow`);
    const height = Number(row.match(/height: (\d+)px/)?.[1]);
    expect(height).toBeLessThanOrEqual(40);
    // A row holds two lines (20 + 16 px) plus its Needs line below the cap; the list scrolls past it.
    expect(height).toBeGreaterThanOrEqual(36);
  });

  it("uses the approved header spacing while keeping narrow wrapping", () => {
    const desktop = css.match(/@media \(min-width: 1200px\) \{\s*\.top \{([^}]*)\}/)?.[1] ?? "";
    expect(desktop).toContain("gap: var(--sp-2) var(--sp-4)");
    expect(rule(String.raw`\.top`)).toContain("flex-wrap: wrap");
    expect(rule(String.raw`\.top`)).toContain("gap: var(--sp-2) var(--sp-4)");
    expect(rule(String.raw`\.top-status`)).toContain("margin-left: auto");
    expect(desktop).not.toContain("display: none");
  });

  it("uses the full viewport width rather than recapping the app shell", () => {
    const shell = rule(String.raw`\.shell`);
    expect(shell).toContain("width: 100%");
    expect(shell).not.toContain("max-width");
    expect(shell).not.toContain("margin: 0 auto");
  });

  it("wraps the header before its desktop contents fit and keeps tabs within their row", () => {
    const desktop = css.match(/@media \(min-width: 1280px\) \{\s*\.top \{([^}]*)\}/)?.[1] ?? "";
    expect(desktop).toContain("flex-wrap: nowrap");
    expect(rule(String.raw`\.top`)).toContain("flex-wrap: wrap");
    expect(rule(String.raw`\.tabs`)).toContain("overflow-x: auto");
    expect(rule(String.raw`\.tabs`)).toContain("max-width: 100%");
    expect(css).toMatch(
      /@media \(max-width: 390px\) \{[\s\S]*?\.top-status \{[\s\S]*?display: grid/,
    );
    expect(css).toMatch(/@media \(max-width: 390px\) \{[\s\S]*?\.top \{[\s\S]*?overflow-x: clip/);
  });

  it("shows the machine tooltip on pointer hover and keyboard focus", () => {
    expect(css).toMatch(
      /\.mach-btn:hover \.mach-tooltip,[\s\S]*?\.mach-btn:focus-visible \.mach-tooltip/,
    );
    expect(rule(String.raw`\.mach-tooltip`)).toContain("visibility: hidden");
    expect(rule(String.raw`\.mach-tooltip`)).toContain("position: absolute");
  });

  it("clamps the machine tooltip to the full status row below 761px", () => {
    expect(css).toMatch(
      /@media \(max-width: 760px\) \{[\s\S]*?\.top-status \{\s*position: relative;\s*width: 100%;/,
    );
    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.mach-btn \{\s*position: static;/);
    expect(css).toMatch(
      /@media \(max-width: 760px\) \{[\s\S]*?\.mach-tooltip \{\s*top: calc\(100% \+ 6px\);\s*right: 0;\s*left: 0;\s*width: auto;\s*max-width: none;/,
    );
  });

  it("bundles the wordmark's Barlow Semi Condensed 700 weight", () => {
    expect(main).toContain('"@fontsource/barlow-semi-condensed/latin-700.css"');
  });
});

it("scrolls the pipeline inside its capped row instead of cutting cards off", () => {
  expect(css).toMatch(/#pipelineP > \.pipeline-grid \{[^}]*min-height: 0;[^}]*overflow-y: auto/);
});
