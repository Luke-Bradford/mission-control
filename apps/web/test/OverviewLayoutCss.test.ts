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
    expect(rule("select")).toContain("min-height: var(--sp-6)");
    expect(rule(String.raw`#agentsList \.need button`)).toContain("min-height: 24px");
    expect(rule(String.raw`\.repo-pick \.chip button`)).toContain("min-height: 24px");
    expect(rule(String.raw`\.overview-lane`)).toContain("min-height: 24px");
    expect(rule(String.raw`\.trow \.rowlink`)).toContain("min-height: 24px");
    for (const selector of [
      String.raw`\.comms-actions button,\n\.comms-react-set button`,
      String.raw`\.comms-metric button`,
      String.raw`#agentsList \.need button`,
      String.raw`button\.flight-link`,
      String.raw`\.ph \.act \.ph-link`,
      String.raw`\.flight-notebook-index a`,
      String.raw`\.flight-note-heading h3 a`,
      String.raw`\.flight-markdown-source summary`,
      String.raw`\.comms-spider-legend \.away`,
      String.raw`\.seg button`,
      String.raw`\.comms-section-head \.comms-needs-link`,
      String.raw`\.comms-mentions-panel header button`,
      String.raw`\.comms-ref`,
      String.raw`\.map-results button`,
      String.raw`\.map-timeline-controls button`,
    ]) {
      expect(rule(selector), selector).toMatch(/font(?:-size)?: (?:600 )?var\(--fs-s\)/);
    }
    const commsActions = rule(String.raw`\.comms-actions button,\n\.comms-react-set button`);
    expect(commsActions).toContain("min-width: 24px");
    expect(commsActions).toContain("min-height: 24px");
    for (const selector of [
      String.raw`\.ph \.act \.ph-link`,
      String.raw`\.flight-markdown-source summary`,
      String.raw`\.comms-spider-legend \.away`,
      String.raw`\.comms-section-head \.comms-needs-link`,
    ]) {
      const action = rule(selector);
      expect(action, selector).toContain("display: inline-flex");
      expect(action, selector).toContain("align-items: center");
      expect(action, selector).toContain("min-height: 24px");
    }
    expect(rule(String.raw`\.comms-spider-legend \.away`)).toContain("min-width: 24px");
    expect(rule(String.raw`\.tip-state`)).toContain("font-size: var(--fs-s)");
    expect(rule(String.raw`\.comms-ref`)).not.toContain("font-size: var(--fs-micro)");
  });

  it("keeps the approved groups content-sized and bounds the roster and evidence lists", () => {
    expect(rule(String.raw`\.overview-grid`)).toContain("display: flex");
    expect(rule(String.raw`\.overview-grid`)).toContain("flex-direction: column");
    expect(rule(String.raw`\.overview-workspace`)).toContain(
      "grid-template-columns: minmax(1052px, 1200px) minmax(500px, 788px)",
    );
    expect(css).toContain("@container overview (max-width: 1050px)");
    expect(css).toMatch(
      /\.overview-primary,[\s\S]*?\.overview-resources \{[^}]*display: flex;[^}]*flex-direction: column/,
    );
    expect(css).not.toContain("margin-top: calc(var(--crew-height");
    expect(css).not.toContain("top: calc(var(--quota-summary-height");
    expect(css).toContain("@container overview (min-width: 2076px)");
    expect(css).toContain("grid-template-columns: 1280px minmax(500px, 1fr) minmax(500px, 1fr)");
    expect(rule("#agentsList")).toContain("overflow-y: auto");
    expect(rule("#agentsList")).toContain("overflow-x: auto");
    expect(rule("#agentsList")).toContain("max-height: calc(12 * var(--table-row))");
    expect(rule(String.raw`\.overview-lane-scroll`)).toContain("max-height: 160px");
    expect(rule(String.raw`\.overview-next`)).toContain("max-height: 320px");
  });

  it("uses eight compact KPI tiles and five content-sized Pipeline summaries", () => {
    expect(rule(String.raw`\.overview-kpis`)).toContain("repeat(4, minmax(0, 1fr))");
    expect(css).toMatch(
      /@container overview \(min-width: 1280px\) \{[\s\S]*?\.overview-kpis \{[^}]*repeat\(8, minmax\(0, 1fr\)\)/,
    );
    expect(rule(String.raw`\.overview-kpi .spark`)).toContain("height: 24px");
    expect(rule(String.raw`\.pipeline-grid`)).toContain("display: flex");
    expect(rule(String.raw`\.pipeline-stage.empty`)).toContain("flex: 0 0 auto");
    expect(rule(String.raw`\.pipeline-stage.empty`)).toContain("min-width: 112px");
    expect(rule(String.raw`\.pipeline-chip`)).toContain("align-items: center");
    expect(rule(String.raw`#agentsList \.trow`)).toContain("min-width: 1050px");
  });

  it("keeps measured Timeline spans labelled and tool instants distinct", () => {
    expect(rule(String.raw`\.overview-lane-scroll`)).toContain("max-height: 160px");
    expect(rule(String.raw`\.overview-span span`)).toContain("padding-inline: var(--sp-1)");
    expect(rule(String.raw`\.overview-instant`)).toContain("position: absolute");
    expect(rule(String.raw`\.timeline-body`)).toContain("flex-direction: column");
  });

  it("aligns full-width measured Machine axes and right-aligned current values", () => {
    expect(rule(String.raw`#machP \.resrow:has\(\.machine-history\)`)).toContain(
      "grid-template-columns: 64px minmax(0, 1fr)",
    );
    expect(rule(String.raw`#machP \.machine-history \.machine-chart`)).toContain("height: 80px");
    expect(rule(String.raw`\.machine-history`)).toContain(
      "grid-template-columns: 48px minmax(0, 1fr)",
    );
    expect(rule(String.raw`#machP \.resrow > \.num`)).toContain("text-align: right");
  });

  it("wraps KPI labels and allows exceptional Work controls to grow past a shared row", () => {
    const label = rule(String.raw`\.overview-kpi .lbl`);
    expect(label).toContain("white-space: normal");
    expect(label).not.toContain("ellipsis");
    const row = rule(String.raw`#agentsList \.trow`);
    expect(row).toContain("min-height: var(--table-row)");
    expect(row).toContain("height: auto");
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

it("sizes the pipeline to its whole cards instead of scrolling or cutting them off", () => {
  expect(css).toMatch(/#pipelineP > \.pipeline-grid \{\s*flex: 0 0 auto;\s*\}/);
  expect(css).not.toMatch(/#pipelineP > \.pipeline-grid \{[^}]*overflow-y: auto/);
});

it("keeps panel actions whole and allows the measured-history selector to wrap", () => {
  expect(rule(String.raw`#overviewHistoryP > \.ph`)).toContain("flex-wrap: wrap");
  expect(rule(String.raw`\.overview-grid \.ph \.act`)).toContain("flex-wrap: nowrap");
});
