import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "../mockups/telemetry");
const mockup = readFileSync(join(dir, "index.html"), "utf8");
const readme = readFileSync(join(dir, "README.md"), "utf8");
const doms: JSDOM[] = [];

const TABS = {
  crew: "Crew",
  cost: "Cost and tokens",
  throughput: "Throughput",
  quality: "Quality",
  machine: "Machine",
} as const;
const PANEL_COUNTS = { crew: 2, cost: 4, throughput: 4, quality: 4, machine: 3 } as const;
const TABLE_COUNTS = { crew: 2, cost: 2, throughput: 1, quality: 1, machine: 1 } as const;
const STATES = ["normal", "loading", "empty", "error", "stale", "disconnected"] as const;

/** The 21 panel ids of the current page (apps/web/src/telemetry). */
const CURRENT_PANELS = [
  "tThru",
  "tCycle",
  "tQual",
  "tCapcom",
  "tCrewState",
  "tFlow",
  "tCycleControl",
  "tQualityTrend",
  "tCostMerged",
  "tForecast",
  "tTok",
  "tUtil",
  "tTurn",
  "tLat",
  "tSubs",
  "tQuota",
  "tMach",
  "tLock",
  "tTicketBars",
  "tStepBars",
  "tTotals",
];
/** The current KPI row, left to right. */
const CURRENT_TILES = [
  "Tokens",
  "~Cost",
  "Tool calls",
  "Commits",
  "Agents working",
  "Merged",
  "Lock wait",
  "Your response",
  "Guard",
  "Test lock",
];
/** The data list: every measure the proposed page shows. */
const MEASURES = [
  "Seats running",
  "Seats waiting on you",
  "Median response",
  "Slowest 10% response",
  "Runs stopped",
  "Agent time by state",
  "Crew state",
  "Tool latency",
  "Subagents",
  "Tool calls",
  "~Cost",
  "Tokens",
  "Cache hit",
  "Tokens per minute",
  "Cost by ticket",
  "Spend by step",
  "Cost coverage",
  "Tokens coverage",
  "Quota used",
  "PRs merged",
  "Cycle time",
  "Tickets in progress",
  "Commits per run",
  "CI first push",
  "First-pass review",
  "Review rounds per PR",
  "RETRO findings per PR",
  "Human review wait",
  "PRs sent back",
  "Escaped defects",
  "Guard blocks",
  "Test attempts",
  "CPU",
  "Memory free",
  "Memory pressure",
  "Swap used",
  "Agent and test-run memory",
  "Test lock",
  "Lock wait",
];

/** The page's visible words: the document text without the script that draws it. */
const wordsOf = (document: Document) => {
  const body = document.body.cloneNode(true) as HTMLElement;
  for (const script of body.querySelectorAll("script")) script.remove();
  return body.textContent ?? "";
};

const render = (search = "") => {
  const dom = new JSDOM(mockup, {
    runScripts: "dangerously",
    url: `http://localhost/telemetry${search}`,
  });
  doms.push(dom);
  return dom.window.document;
};

afterEach(() => {
  doms.splice(0).forEach((dom) => {
    dom.window.close();
  });
});

describe("Telemetry mockup README", () => {
  it("lists every current panel and measure", () => {
    expect(readme).toMatch(/\|\s*KPI band\s*\|/);
    for (const tile of CURRENT_TILES) expect(readme, tile).toContain(`\`${tile}\``);
    for (const id of CURRENT_PANELS) expect(readme, id).toMatch(new RegExp(`\\|\\s*\`${id}\``));
    for (const measure of MEASURES)
      expect(readme, measure).toMatch(
        new RegExp(`\\|\\s*${measure.replace(/[~.]/g, "\\$&")}\\s*\\|`),
      );
  });

  it("states that it is a fictional proposal", () => {
    expect(readme).toContain("Approval: waiting for the operator.");
    const banner = "Proposal mockup. Every number is fictional, shaped to the hub's real ranges.";
    expect(render().querySelector(".banner")?.textContent).toBe(banner);
  });

  it("outlines one build ticket per tab", () => {
    const section = readme.split(/^## Build tickets$/m)[1] ?? "";
    const headings = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(Object.values(TABS));
  });
});

describe("Telemetry mockup", () => {
  it("shows the health band above five tabs, named as the plan says", () => {
    const document = render();
    expect(
      [...document.querySelectorAll(".band .stat .stat-label")].map((e) => e.textContent),
    ).toEqual([
      "Crew health",
      "Your response",
      "~Cost",
      "Merged",
      "CI first push",
      "First-pass review",
      "Tightest quota",
      "Machine",
    ]);
    expect([...document.querySelectorAll('[role="tab"]')].map((e) => e.textContent)).toEqual(
      Object.values(TABS),
    );
    const band = document.querySelector(".band");
    const tabs = document.querySelector('[role="tablist"]');
    expect(band && tabs && band.compareDocumentPosition(tabs) & 4).toBeTruthy();
  });

  it("gives Crew health the verdict the rules produce", () => {
    const verdict = render().querySelector('[data-stat="health"] .stat-value');
    expect(verdict?.textContent).toMatch(/^Watch/);
  });

  for (const tab of Object.keys(TABS)) {
    it(`draws ${tab} with at most four charts, five stat fields and a drill on every number`, () => {
      const document = render(`?tab=${tab}`);
      expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
        TABS[tab as keyof typeof TABS],
      );
      expect(document.querySelectorAll(".panel .chart").length).toBeLessThanOrEqual(4);
      expect(document.querySelectorAll(".panel").length).toBe(
        PANEL_COUNTS[tab as keyof typeof PANEL_COUNTS],
      );
      expect(document.querySelectorAll(".panel table").length).toBe(0);
      const stats = [...document.querySelectorAll(".stat")];
      expect(stats.length).toBeGreaterThanOrEqual(8 + 4);
      for (const stat of stats) {
        for (const field of ["label", "value", "unit", "window", "def"])
          expect(stat.querySelector(`.stat-${field}`), `${stat.className} ${field}`).not.toBeNull();
        const number = stat.querySelector("[data-drill]");
        expect(["exists", "needs-build"]).toContain(number?.getAttribute("data-drill"));
      }
    });
  }

  it("keeps gaps as breaks and never plots a zero in one", () => {
    for (const tab of Object.keys(TABS)) {
      const document = render(`?tab=${tab}`);
      for (const chart of document.querySelectorAll(".chart[data-gaps]")) {
        expect(chart.querySelectorAll(".gapband").length).toBeGreaterThan(0);
        for (const mark of chart.querySelectorAll("[data-v]")) {
          const values = (mark.getAttribute("data-v") ?? "").split(",");
          expect(values, `${tab} ${mark.getAttribute("class")}`).not.toContain("0");
          expect(values).not.toContain("");
        }
      }
    }
  });

  it("says what is missing, word for word", () => {
    const text = (tab: string) => wordsOf(render(`?tab=${tab}`));
    expect(text("cost")).toMatch(
      /Cost covers \d+% of runs; the rest reported none\. Not counted as \$0\./,
    );
    expect(text("cost")).toMatch(
      /Tokens cover \d+% of runs; the rest reported none\. Not counted as 0\./,
    );
    expect(text("quality")).toContain(
      "No review recorded since 1 Nov. The line stops there; it does not mean zero.",
    );
    expect(text("quality")).toContain(
      "Not collected yet: test attempts. Nothing is stored for this measure.",
    );
    expect(text("quality")).toMatch(/Collected since \d+ \w+\. Earlier days are blank, not zero\./);
    expect(text("throughput")).toMatch(
      /Collected since \d+ \w+\. Earlier days are blank, not zero\./,
    );
  });

  it("offers every range but holds 24h only", () => {
    const buttons = [...render().querySelectorAll<HTMLButtonElement>("[data-range]")];
    expect(buttons.map((b) => b.textContent)).toEqual(["1h", "6h", "24h", "7d"]);
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    for (const b of buttons.filter((x) => x.textContent !== "24h")) {
      expect(b.disabled).toBe(true);
      expect(b.title).toBe("Mockup shows 24h");
    }
  });

  it("shows filters only where they apply", () => {
    const filters = (tab: string) =>
      [...render(`?tab=${tab}`).querySelectorAll(".filters select")]
        .filter((s) => !s.closest("[hidden]"))
        .map((s) => s.getAttribute("data-filter"));
    expect(filters("cost")).toEqual(["agent", "account", "ticket"]);
    expect(filters("crew")).toEqual(["agent"]);
    for (const tab of ["throughput", "quality", "machine"]) expect(filters(tab)).toEqual([]);
  });

  it("names a fixed 14-day window on Throughput and Quality", () => {
    for (const tab of ["throughput", "quality"])
      expect(render(`?tab=${tab}`).querySelector(".summary")?.textContent).toContain(
        "Last 14 days",
      );
  });

  it("moves between tabs with the arrow keys and keeps the tab in the query", () => {
    const document = render("?tab=crew");
    const window = document.defaultView as unknown as Window & typeof globalThis;
    const tab = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    tab?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Cost and tokens",
    );
    expect(window.location.search).toContain("tab=cost");
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(window.location.search).toContain("tab=crew");
  });

  it("swaps the charts for the tab's tables in place", () => {
    for (const tab of Object.keys(TABS)) {
      const document = render(`?tab=${tab}&view=table`);
      expect(document.querySelectorAll(".panel table").length).toBe(
        TABLE_COUNTS[tab as keyof typeof TABLE_COUNTS],
      );
      expect(document.querySelectorAll(".panel .chart").length).toBe(0);
    }
  });

  it("opens the runs dialog from a number that needs a build, and returns focus", () => {
    const document = render();
    const window = document.defaultView as unknown as Window & typeof globalThis;
    const number = document.querySelector<HTMLElement>('.band [data-drill="needs-build"]');
    number?.focus();
    number?.click();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.hidden).toBe(false);
    expect(dialog?.textContent).toContain("Runs behind this number");
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/needs build/i);
    dialog?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog?.hidden).toBe(true);
    expect(document.activeElement).toBe(number);
  });

  it("names the target of a number that already has a page", () => {
    const document = render();
    document.querySelector<HTMLElement>('.band [data-drill="exists"]')?.click();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/^Opens /);
    expect(document.querySelector<HTMLElement>('[role="dialog"]')?.hidden).toBe(true);
  });

  const STATE_TEXT: Record<string, RegExp> = {
    loading: /Loading…/,
    empty: /Nothing ran in the last 24h\./,
    error: /Telemetry did not load\./,
    stale: /Figures are \d+ min old\./,
    disconnected: /Not connected to the hub\. These figures are from \d\d:\d\d\./,
  };
  for (const state of STATES.filter((s) => s !== "normal")) {
    it(`words the ${state} state`, () => {
      const document = render(`?tab=crew&state=${state}`);
      expect(wordsOf(document)).toMatch(STATE_TEXT[state]);
      expect(wordsOf(document)).not.toMatch(/No data/i);
    });
  }

  it("recovers from the error state with Try again", () => {
    const document = render("?state=error");
    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again",
    );
    expect(retry).toBeTruthy();
    retry?.click();
    expect(wordsOf(document)).not.toContain("Telemetry did not load.");
  });

  it("marks every plotted gap: a note about missing days has a band and fewer points than buckets", () => {
    for (const tab of Object.keys(TABS)) {
      const document = render(`?tab=${tab}`);
      for (const panel of document.querySelectorAll(".panel")) {
        if (!/Collected since|No review recorded since/.test(panel.textContent ?? "")) continue;
        const chart = panel.querySelector(".chart");
        expect(
          chart?.querySelectorAll(".gapband").length,
          panel.getAttribute("data-panel") ?? "",
        ).toBeGreaterThan(0);
        const buckets = Number(chart?.getAttribute("data-n"));
        const plotted = [...(chart?.querySelectorAll("path[data-v], rect[data-v]") ?? [])].map(
          (mark) => (mark.getAttribute("data-v") ?? "").split(",").length,
        );
        expect(Math.min(...plotted), panel.getAttribute("data-panel") ?? "").toBeLessThan(buckets);
      }
    }
  });

  it("uses a seat colour only for a series that is a seat", () => {
    const seats = [
      "flight",
      "dev-1",
      "dev-2",
      "dev-3",
      "rev-1",
      "rev-2",
      "qa-1",
      "plan-1",
      "plan-2",
      "ops-1",
      "loop-1",
    ];
    for (const tab of Object.keys(TABS)) {
      const document = render(`?tab=${tab}`);
      for (const mark of document.querySelectorAll("[data-series]")) {
        const paint = `${mark.getAttribute("fill")} ${mark.getAttribute("stroke")}`;
        if (paint.includes("--seat-"))
          expect(seats, `${tab} ${mark.getAttribute("data-series")}`).toContain(
            mark.getAttribute("data-series"),
          );
      }
      for (const item of document.querySelectorAll(".readout li")) {
        const swatch = item.querySelector<HTMLElement>(".sw");
        if (swatch?.getAttribute("style")?.includes("--seat-"))
          expect(seats, tab).toContain(item.querySelector(".nm")?.textContent);
      }
      for (const el of document.querySelectorAll(
        ".rows [style*='--seat-'], .panel i[style*='--seat-']",
      ))
        expect(el.closest(".seat, .readout"), `${tab} ${el.outerHTML}`).not.toBeNull();
    }
  });

  it("gives every number in a chart list or table a drill", () => {
    for (const tab of Object.keys(TABS)) {
      for (const view of ["", "&view=table"]) {
        const document = render(`?tab=${tab}${view}`);
        const numbers = [...document.querySelectorAll(".rows .vl, .readout .vl, td.num")];
        // Escaped defects has no numeric column; blank legend keys are not values.
        if (!(tab === "quality" && view))
          expect(numbers.length, `${tab}${view}`).toBeGreaterThan(0);
        for (const number of numbers) {
          if (!/\d/.test(number.textContent ?? "")) continue;
          const drill = number.matches("[data-drill]")
            ? number
            : number.querySelector("[data-drill]");
          expect(["exists", "needs-build"], `${tab}${view} ${number.textContent}`).toContain(
            drill?.getAttribute("data-drill"),
          );
          expect(drill?.tagName, `${tab} ${number.textContent}`).toBe("BUTTON");
          expect(drill?.getAttribute("data-target")?.trim().length).toBeGreaterThan(0);
          expect(drill?.getAttribute("data-label")?.trim().length).toBeGreaterThan(0);
          expect((drill as HTMLButtonElement)?.tabIndex).toBe(0);
        }
      }
    }
  });

  it("keeps each readout drill while the cursor changes its displayed value or crosses a gap", () => {
    const document = render("?tab=cost");
    const window = document.defaultView as unknown as Window & typeof globalThis;
    const plot = document.querySelector<HTMLElement>('[data-panel="tpm"] .plot');
    const value = document.querySelector<HTMLElement>('[data-panel="tpm"] .readout .vl');
    const button = value?.querySelector<HTMLButtonElement>("button");
    expect(plot).not.toBeNull();
    expect(button).not.toBeNull();
    if (!plot || !value || !button) throw new Error("Missing token-rate readout");
    const latest = button.textContent;
    plot.getBoundingClientRect = () => ({ left: 0, width: 710 }) as DOMRect;
    button.focus();
    plot.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 0 }));
    expect(value.querySelector("button")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).not.toBe(latest);
    expect(button.dataset.shown).toBe(button.textContent);
    const sampled = button.textContent;
    button.click();
    expect(document.querySelector("#dlg-what")?.textContent).toContain(sampled);
    document.querySelector<HTMLButtonElement>("#dlg-close")?.click();
    plot.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 300 }));
    expect(button.textContent).toBe("—");
    expect(button.disabled).toBe(true);
    button.click();
    expect(document.querySelector<HTMLElement>("#dlg")?.hidden).toBe(true);
    plot.dispatchEvent(
      new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(value.querySelector("button")).toBe(button);
    expect(button.textContent).toBe(latest);
    expect(button.dataset.shown).toBe(latest);
    expect(button.disabled).toBe(false);
  });

  it("draws state with shapes in both seat panels, and lets a title be focused", () => {
    const crew = render("?tab=crew");
    for (const state of ["running", "waiting", "parked", "idle"])
      expect(
        crew.querySelector(`.lane .sp.${state}`) ?? crew.querySelector(`.sw.st-${state}`),
        state,
      ).not.toBeNull();
    expect(crew.querySelector(".rows .tr i.s-waiting")).not.toBeNull();
    const cost = render("?tab=cost");
    const title = cost.querySelector<HTMLElement>('[data-panel="by-ticket"] .lb');
    expect(title?.getAttribute("tabindex")).toBe("0");
    expect(title?.getAttribute("data-tip")).toContain("demo#");
  });

  it("shows the worst case: a named Needs attention reason, 50 tickets and a 300-character title", () => {
    const document = render("?tab=cost&data=worst");
    expect(document.querySelector('[data-stat="health"] .stat-value')?.textContent).toMatch(
      /^Needs attention/,
    );
    expect(document.querySelector('[data-stat="health"] .stat-sub')?.textContent).toContain(
      "acct-a · 7d at stop level",
    );
    expect(
      document.querySelector('[data-stat="health"] .stat-value')?.getAttribute("aria-label"),
    ).toContain("acct-a · 7d at stop level");
    expect(document.querySelectorAll('[data-panel="by-ticket"] .r').length).toBe(50);
    expect(
      document.querySelector('[data-panel="by-ticket"] .lb')?.getAttribute("data-tip")?.length,
    ).toBeGreaterThan(300);
  });

  it("opens FLIGHT's dock beside the page", () => {
    const document = render("?flight=open");
    const window = document.defaultView as unknown as Window & typeof globalThis;
    expect(document.querySelector(".app")?.classList.contains("flight-open")).toBe(true);
    expect(document.querySelector<HTMLElement>("#dock")?.hidden).toBe(false);
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(document.querySelector<HTMLElement>("#dock")?.hidden).toBe(true);
  });

  it("uses no real repo names, paths or commands", () => {
    expect(mockup).not.toMatch(/mission-control|Luke-Bradford|\/Users\/|C:\\|git push|pnpm/i);
    expect(mockup).toContain("demo");
  });
  it("keeps selected-tab focus and filter choices across a view change", () => {
    const document = render("?tab=cost");
    const descriptions = [...document.querySelectorAll(".stat-value")].map((value) =>
      value.getAttribute("aria-describedby"),
    );
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const description of descriptions)
      expect(document.getElementById(description ?? "")?.getAttribute("role")).toBe("tooltip");
    const window = document.defaultView as unknown as Window & typeof globalThis;
    const select = document.querySelector<HTMLSelectElement>('[data-filter="agent"]');
    if (!select) throw new Error("Missing agent filter");
    select.value = "dev-1";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    const tab = document.getElementById("tab-cost");
    tab?.focus();
    tab?.click();
    expect(document.activeElement?.id).toBe("tab-cost");
    document.querySelector<HTMLButtonElement>('[data-view="table"]')?.click();
    expect(document.querySelector<HTMLSelectElement>('[data-filter="agent"]')?.value).toBe("dev-1");
    for (const table of document.querySelectorAll("table")) {
      const labels = [...table.querySelectorAll("tbody tr")].map(
        (row) => row.firstElementChild?.textContent ?? "",
      );
      expect(labels).toEqual(
        [...labels].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      );
    }
  });

  it("does not open runs for blank values, links definitions, and restores focus after retry", () => {
    const empty = render("?state=empty");
    const value = empty.querySelector<HTMLButtonElement>(".stat-value");
    expect(value?.disabled).toBe(true);
    value?.click();
    expect(empty.getElementById("dlg")?.hasAttribute("hidden")).toBe(true);
    expect(
      empty.getElementById(value?.getAttribute("aria-describedby") ?? "")?.getAttribute("role"),
    ).toBe("tooltip");
    const error = render("?tab=quality&state=error");
    error.querySelector<HTMLButtonElement>("[data-retry]")?.click();
    expect(error.activeElement?.id).toBe("tab-quality");
  });
  it("distinguishes the nonzero observed Today spend from the complete 24-hour chart total", () => {
    const document = render("?tab=cost");
    const money = (text: string | null | undefined) => Number((text ?? "").replace(/[^0-9.]/g, ""));
    const today = money(document.querySelector('[data-stat="cost"] .stat-value')?.textContent);
    const totals = [...document.querySelectorAll('[data-panel="spend"] .readout li')]
      .slice(0, 4)
      .map((row) => money(row.querySelector(".vl")?.textContent));
    const full = totals[3] ?? 0;
    expect(today).toBeGreaterThan(0);
    expect(today).toBeLessThan(full);
    expect(full).toBeCloseTo(
      totals.slice(0, 3).reduce((a, b) => a + b, 0),
      2,
    );
  });
});
