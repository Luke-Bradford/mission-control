import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const mockup = readFileSync(join(import.meta.dirname, "../mockups/overview/index.html"), "utf8");
const doms: JSDOM[] = [];

const renderMockup = () => {
  const dom = new JSDOM(mockup, { runScripts: "dangerously", url: "http://localhost/overview" });
  doms.push(dom);
  return dom.window.document;
};

afterEach(() => {
  doms.splice(0).forEach((dom) => {
    dom.window.close();
  });
});

describe("Overview v2 mockup", () => {
  it("keeps the desktop pipeline tall enough for its Board controls", () => {
    expect(mockup).toContain("grid-template-rows:62px 458px 176px minmax(0,1fr)");
  });

  it("uses the live header order and names the data behind its dense samples", () => {
    const document = renderMockup();

    expect([...document.querySelectorAll(".nav a")].map((tab) => tab.textContent)).toEqual([
      "Overview",
      "FLIGHT",
      "Board",
      "Agents",
      "Map",
      "Comms",
      "Telemetry",
      "Audit",
    ]);
    expect(document.querySelector(".crewrow.header")?.lastElementChild?.textContent).toBe(
      "In state",
    );
    expect(mockup).toContain("#1060");
  });

  it("has one accurate filtered Board link for every populated pipeline stage", () => {
    const document = renderMockup();
    const stages = [...document.querySelectorAll(".pipeline .stage")];

    expect(
      stages.map((stage) => stage.querySelector(".more")?.getAttribute("href") ?? null),
    ).toEqual(["/board?stage=ready", "/board?stage=progress", null, "/board?stage=merged"]);
    expect(stages.map((stage) => stage.querySelector(".more")?.textContent ?? null)).toEqual([
      "+4 · open Board ›",
      "+6 · open Board ›",
      null,
      "+3 · open Board ›",
    ]);
  });

  it("keeps crew and pipeline summaries consistent with their rendered states", () => {
    const document = renderMockup();
    const counts = [...document.querySelectorAll("#crewRows .pill")].reduce((totals, pill) => {
      const state = pill.textContent ?? "";
      totals.set(state, (totals.get(state) ?? 0) + 1);
      return totals;
    }, new Map<string, number>());
    const crewSummary = document.querySelector("#crew .sub")?.textContent ?? "";
    const crewHeadline = document.querySelector(".health b")?.textContent ?? "";
    const workingKpi = document.querySelector(".kpi b")?.textContent ?? "";
    const pipelineSummary = document.querySelector("#pipeline .sub")?.textContent ?? "";
    const stageTotal = [...document.querySelectorAll("#pipeline .stage h3 span")].reduce(
      (total, count) => total + Number(count.textContent),
      0,
    );

    expect(crewSummary).toContain(`${counts.get("Working")} working`);
    expect(crewHeadline).toBe(`${counts.get("Working")} working`);
    expect(workingKpi).toBe(String(counts.get("Working")));
    expect(crewSummary).toContain(`${counts.get("Waiting")} waiting`);
    expect(crewSummary).toContain(`${counts.get("Free")} free`);
    expect(crewSummary).toContain(`${counts.get("Checking")} checking`);
    expect(pipelineSummary).toContain(`${stageTotal} tickets`);
  });

  it("keeps the compact Overview contracts in the fixture", () => {
    const document = renderMockup();
    const quotaLabels = [...document.querySelectorAll(".quotaRow > span")].map(
      (label) => label.textContent,
    );
    const logEvents = [...document.querySelectorAll(".log .event")].map(
      (event) => event.textContent ?? "",
    );

    expect(mockup).toContain(".pipeline .stage.empty{flex:0 0 112px}");
    expect(mockup).toContain(".pipeline .body{padding:8px 16px;display:flex");
    expect(mockup).toContain("line-height:16px");
    expect(mockup).toContain(".bar.review");
    expect(mockup).toContain("--crit:#a73838");
    expect(mockup).toContain(".log .line");
    expect(mockup).toContain("white-space:nowrap");
    expect(mockup).toContain(':root[data-theme="light"]{color-scheme:light;');
    expect([...document.querySelectorAll("#crewRows .work")]).toHaveLength(11);
    expect([...document.querySelectorAll("#crewRows .work b")]).toHaveLength(11);
    expect([...document.querySelectorAll("#crewRows .work span")]).toHaveLength(11);
    expect(
      [...document.querySelectorAll("#crewRows .work b")].every((value) =>
        value.hasAttribute("title"),
      ),
    ).toBe(true);
    expect(
      [...document.querySelectorAll("#crewRows .work span")].every((value) =>
        value.hasAttribute("aria-label"),
      ),
    ).toBe(true);
    expect(
      [...document.querySelectorAll(".owner")].every((owner) =>
        owner.getAttribute("aria-label")?.startsWith("Owner "),
      ),
    ).toBe(true);
    expect(logEvents.every((event) => event.length <= 120)).toBe(true);
    expect(quotaLabels).toContain("Codex 7d");
    expect(quotaLabels).not.toContain("Codex 5h");
    expect(document.querySelector(".quotaRow b")?.textContent).toContain(
      "full in ~2d at this rate",
    );
    expect(document.querySelectorAll(".quotaRow b")[2]?.textContent).toContain(
      "full in ~6d at this rate",
    );
  });

  it("draws metric-specific dense sample paths with dots and accessible windows", () => {
    const document = renderMockup();
    const charts = [...document.querySelectorAll(".spark,.chart")];

    expect(charts).toHaveLength(12);
    for (const chart of charts) {
      const line = chart.querySelector("polyline");
      const points = line?.getAttribute("points")?.split(" ") ?? [];
      const dots = [...chart.querySelectorAll("circle")];
      expect(points).toHaveLength(60);
      expect(dots).toHaveLength(60);
      expect(dots[0]?.getAttribute("cx")).toBe(points[0]?.split(",")[0]);
      expect(dots[0]?.getAttribute("cy")).toBe(points[0]?.split(",")[1]);
      expect(chart.querySelector("svg")?.getAttribute("aria-label")).toContain("last 60 minutes");
    }
    expect(
      new Set(charts.map((chart) => chart.querySelector("polyline")?.getAttribute("points"))).size,
    ).toBe(12);
  });

  it("updates the theme action name and opens a focusable log detail panel", () => {
    const document = renderMockup();
    const theme = document.querySelector<HTMLButtonElement>(".theme");
    const logLink = document.querySelector<HTMLAnchorElement>(".why");
    const detail = document.querySelector<HTMLElement>("#log-detail");

    if (!theme || !logLink || !detail) throw new Error("Mockup controls are missing");
    theme.click();
    expect(theme.getAttribute("aria-label")).toBe("Toggle dark theme");
    logLink.click();
    expect(detail.hidden).toBe(false);
    expect(document.activeElement).toBe(detail.querySelector("button"));
    const view = document.defaultView;
    if (!view) throw new Error("Mockup window is missing");
    document.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape" }));
    expect(detail.hidden).toBe(true);
    expect(document.activeElement).toBe(logLink);
  });
});
