import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "../mockups/dependencies");
const readme = readFileSync(join(dir, "README.md"), "utf8");
const mockup = readFileSync(join(dir, "index.html"), "utf8");

/** The README text under the heading `title`, up to the next heading of the same or higher level. */
function section(title: string, text = readme): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^#{1,6} /.test(line) && line.includes(title));
  if (start < 0) return "";
  const level = lines[start]?.match(/^#+/)?.[0].length ?? 1;
  const end = lines.findIndex(
    (line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const BANNER =
  "Proposal mockup. Replay of the 30 October chain. Ages are illustrative. This work has since moved on.";

const INTERFACE_TEXTS = [
  "Blocked chains",
  "longest wait first · time since the hub first saw each wait",
  "Waits on",
  "Unblocks",
  "depends on",
  "stacked on",
  "held for",
  "behind in seat queue",
  "also waits on",
  "Stuck",
  "With you",
  "Moving",
  "Merging this frees",
  "more also wait on other work",
  "No recorded work waits on this PR.",
  "Nothing is waiting on other work.",
  "Reading what waits on what…",
  "Blocked chains did not load.",
  "Try again",
  "Showing the last read,",
  "Not connected to the hub. This list is from",
  "The hub has no start time for this wait.",
  "These tickets wait on each other.",
  "not read yet",
];

const HEADERS = ["Work", "State", "What holds it", "Next owner", "Waited", "Merge frees"];

describe("Dependencies mockup records", () => {
  it("records the research, plan and approval state", () => {
    expect(readme).toContain("Approval: waiting for the operator.");

    const research = section("Research");
    for (const tool of ["Linear", "GitHub", "Jira", "Shortcut", "Gantt critical path"]) {
      const row = research.split("\n").find((line) => line.startsWith("|") && line.includes(tool));
      expect(row, `a research row for ${tool}`).toBeDefined();
      expect(row).toMatch(/https?:\/\/\S+|Unconfirmed/);
    }

    expect(mockup).toContain(BANNER);
    for (const text of INTERFACE_TEXTS) expect(mockup, text).toContain(text);
    for (const header of HEADERS) expect(mockup, header).toContain(`"${header}"`);
  });

  it("outlines every build ticket", () => {
    const tickets = section("Build tickets");
    expect(tickets).not.toBe("");
    for (const name of ["Server read", "Board", "FLIGHT panel", "QA"]) {
      const body = section(name, tickets);
      expect(body, `a "${name}" build ticket`).not.toBe("");
      expect(body).toContain("Done when");
      expect(body).toContain("Size");
    }
    expect(section("Board", tickets)).toContain("Depends on");
    expect(section("Board", tickets)).toContain("Blocked");
  });
});

const script = /<script>([\s\S]*?)<\/script>/.exec(mockup)?.[1] ?? "";

/** Runs the mockup's own script for a query; a script error throws and fails the test. */
function render(search: string): Document {
  const dom = new JSDOM(mockup.replace(script, ""), {
    runScripts: "outside-only",
    url: `http://localhost/mockup${search}`,
  });
  (dom.window as unknown as { eval(code: string): void }).eval(script);
  return dom.window.document;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("Dependencies mockup in jsdom", () => {
  it("renders every view in every state without a script error", () => {
    for (const view of ["board", "flight", "qa"])
      for (const state of [
        "normal",
        "many",
        "long",
        "loading",
        "empty",
        "error",
        "stale",
        "disconnected",
      ]) {
        const document = render(`?view=${view}&state=${state}&theme=light`);
        expect(document.querySelector(".banner")?.textContent, `${view} ${state}`).toContain(
          BANNER,
        );
        expect(document.documentElement.dataset.theme).toBe("light");
      }
  });

  it("lists the four chains longest wait first, with the stats from them", () => {
    const document = render("?view=flight&state=normal");
    const roots = [...document.querySelectorAll("#chainsP .tr.root")].map((row) =>
      row.getAttribute("data-ref"),
    );
    expect(roots).toEqual(["PR 1033", "PR 1189", "demo PR 21", "demo PR 22"]);
    expect(
      [...document.querySelectorAll("#chainsP .stat")].map((stat) =>
        [...stat.children].map(text).join(" "),
      ),
    ).toEqual([
      "Chains 4 roots",
      "Stuck 2 of 4",
      "Waiting 9 tickets and PRs",
      "Longest wait 3d 4h since first seen",
    ]);
    expect([...document.querySelectorAll("#chainsP [role=columnheader]")].map(text)).toEqual([
      "Work",
      "State",
      "What holds it",
      "Next owner",
      "Waited ▼",
      "Merge frees",
    ]);
    // 4 roots plus 10 dependents; one ticket sits under two roots
    expect(document.querySelectorAll("#chainsP .tr:not(.th)").length).toBe(14);
  });

  it("moves Ready tickets with Depends on to Blocked and says so", () => {
    const document = render("?view=board&state=normal");
    const count = (name: string) => document.querySelectorAll(`#col-${name} .card`).length;
    expect(count("Ready")).toBe(4);
    expect(count("Blocked")).toBe(7);
    expect(text(document.querySelector(".boardnote"))).toContain("down from 11");
    const chips = [...document.querySelectorAll("#col-Blocked [data-chip=waits]")].map(text);
    expect(chips).toContain("Waits on PR 1033 · Ready for QA · 3d 4h");
    expect(chips).toContain("Waits on demo PR 21 · In review · 6h +1");
    expect(text(document.querySelector("#col-Ready-for-QA [data-chip=unblocks]"))).toBe(
      "Unblocks 3",
    );
    expect(document.querySelectorAll("#col-Done [data-chip]").length).toBe(0);
  });

  it("gives each Blocked card its reason as a link to the ticket it depends on", () => {
    const document = render("?view=board&state=normal");
    const link = (ref: string) =>
      document.querySelector(`#col-Blocked [data-reason='${ref}'] a`)?.getAttribute("href");
    expect(link("#1139")).toBe("/tickets/mission-control/1015");
    expect(link("demo#34")).toBe("/tickets/demo/22");
    expect(text(document.querySelector("#col-Blocked [data-reason='#1138']"))).toBe(
      "Blocked: stacked on #1015",
    );
    expect(document.querySelectorAll("#col-Blocked .card").length).toBe(
      document.querySelectorAll("#col-Blocked [data-reason]").length,
    );
    // an untracked repo's ticket is text, not a link
    const many = render("?view=board&state=many");
    expect(many.querySelector("[data-reason='demo#60'] a")).toBeNull();
  });

  it("counts what a merge frees the same way on Board, FLIGHT and QA", () => {
    const board = render("?view=board&state=normal");
    expect(
      text(board.querySelector("[data-ticket='demo#21'] [data-chip=unblocks]")),
    ).toBe("Unblocks 2");
    const row = render("?view=qa&pr=demo-21").querySelector("#queueP a.row.on");
    expect(text(row)).toContain("unblocks 2");
    expect(text(render("?view=qa&pr=demo-21").querySelector("[data-frees]"))).toContain(
      "Merging this frees 2",
    );
    const flight = render("?view=flight&state=normal");
    expect(
      text(flight.querySelector("[data-ref='demo PR 21'] [role=cell]:last-child")),
    ).toBe("2");
  });

  it("draws the Board's columns in their real order", () => {
    const document = render("?view=board&state=normal");
    expect(
      [...document.querySelectorAll(".col .phead h2")].map((h2) => h2.firstChild?.textContent),
    ).toEqual([
      "Backlog",
      "Refinement",
      "Blocked",
      "Ready",
      "In progress",
      "In review",
      "Ready for QA",
      "Done",
    ]);
    expect(document.querySelectorAll("#col-In-review .card").length).toBeGreaterThan(0);
  });

  it("draws the live Seats columns and keeps Seats and Blocked consistent", () => {
    const document = render("?view=flight&state=normal");
    expect([...document.querySelectorAll("#wifP [role=columnheader]")].map(text)).toEqual([
      "Seat",
      "Workstream",
      "Stage",
      "Stuck / waiting on",
      "FLIGHT's next action",
      "Last instruction",
    ]);
    const blocked = [
      ...render("?view=board&state=normal").querySelectorAll("#col-Blocked .card"),
    ].map((card) => card.getAttribute("data-ticket"));
    const working = [...document.querySelectorAll("#wifP [data-seat-state=Working]")].map(text);
    expect(working.length).toBeGreaterThan(0);
    for (const row of working) for (const ticket of blocked) expect(row).not.toContain(`${ticket} `);
  });

  it("links an owner only when there is one", () => {
    const document = render("?view=flight&state=normal");
    expect(document.querySelector("[data-ref='PR 1189'] a[href^='/agent/']")).toBeNull();
    expect(document.querySelector("[data-ref='demo PR 21'] a[href^='/agent/']")).not.toBeNull();
  });

  it("puts every ticket back in Ready while the chains have not loaded", () => {
    const document = render("?view=board&state=loading");
    expect(document.querySelectorAll("#col-Blocked .card").length).toBe(0);
    expect(text(document.querySelector(".boardnote"))).toContain("until the chains load");
  });

  it("shows what a merge frees on QA", () => {
    expect(text(render("?view=qa&pr=1033").querySelector("[data-frees]"))).toContain(
      "Merging this frees 3",
    );
    expect(text(render("?view=qa&pr=demo-21").querySelector("[data-frees]"))).toContain(
      "1 more also wait on other work",
    );
    expect(text(render("?view=qa&pr=1034").querySelector("[data-frees]"))).toBe(
      "No recorded work waits on this PR.",
    );
  });

  it("caps a long chain at four rows and discloses the rest", () => {
    const document = render("?view=flight&state=many");
    const button = document.querySelector<HTMLButtonElement>("[data-more='demo PR 44']");
    expect(button?.textContent).toBe("5 more");
    button?.click();
    expect(document.querySelector("[data-more='demo PR 44']")).toBeNull();
  });

  it("words each non-data state", () => {
    expect(text(render("?view=flight&state=empty").querySelector(".chains-scroll"))).toBe(
      "Nothing is waiting on other work.",
    );
    expect(text(render("?view=flight&state=loading").querySelector(".chains-scroll"))).toBe(
      "Reading what waits on what…",
    );
    expect(text(render("?view=flight&state=error").querySelector(".strip"))).toBe(
      "Blocked chains did not load.Try again",
    );
    expect(text(render("?view=flight&state=stale").querySelector(".strip"))).toBe(
      "Showing the last read, 7 min old.",
    );
    expect(text(render("?view=flight&state=disconnected").querySelector(".strip"))).toBe(
      "Not connected to the hub. This list is from 14:02.",
    );
  });
});
