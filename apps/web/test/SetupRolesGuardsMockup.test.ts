import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GUARD_NOTE, GUARD_RULES } from "@mc/core";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { TAB_LABEL } from "../src/flight/tabs.ts";

const root = join(import.meta.dirname, "../../..");
const dir = join(import.meta.dirname, "../mockups/setup-roles-guards");
const mockup = readFileSync(join(dir, "index.html"), "utf8");
const readme = readFileSync(join(dir, "README.md"), "utf8");
const doms: JSDOM[] = [];

const GROUPS = {
  "Work the crew picks": ["pick_from", "needs", "areas", "promote_backlog"],
  "Protected files": ["protected", "hard_rules", "hard_rules_by"],
  Checks: ["commands.writer", "commands.review", "full_suite", "required_checks", "checks"],
  "Your approval": ["uat.labels", "uat.paths", "always_ask"],
  Authority: ["autonomy", "flight_powers"],
} as const;
const SOURCES = ["here", "repo", "default", "builtin"];
const BADGES: Record<string, [string, string]> = {
  here: ["Set here", "Saved in config.yaml. Edit it here."],
  repo: ["Repo file", "Set in the repo's CLAUDE.md. Change it with a reviewed PR."],
  default: ["Default", "Mission Control's default. Edit it here to set your own."],
  builtin: ["Built in", "Part of Mission Control's code. It cannot be turned off."],
};
const STATES = [
  "normal",
  "loading",
  "empty",
  "long",
  "error",
  "stale",
  "disconnected",
  "conflict",
] as const;
const PAGES = [
  "Overview",
  "FLIGHT",
  "Needs you",
  "Board",
  "Agent",
  "Trace",
  "Map",
  "Comms",
  "QA",
  "Telemetry",
  "Audit",
  "Setup — Accounts",
  "Setup — Repos & seats",
  "Setup — Roles & guards",
  "Setup — Loops",
  "Setup — Sources",
  "Setup — Safety",
];

const render = (search = "") => {
  const dom = new JSDOM(mockup, {
    runScripts: "dangerously",
    url: `http://localhost/roles${search}`,
  });
  doms.push(dom);
  return dom.window.document;
};
const wordsOf = (document: Document) => {
  const body = document.body.cloneNode(true) as HTMLElement;
  for (const script of body.querySelectorAll("script")) script.remove();
  return body.textContent ?? "";
};

afterEach(() => {
  doms.splice(0).forEach((dom) => {
    dom.window.close();
  });
});

describe("Setup Roles & guards mockup", () => {
  it("names every repo setting with its source", () => {
    for (const repo of ["demo-app", "demo-site"]) {
      const document = render(`?repo=${repo}`);
      const groups = [...document.querySelectorAll(".group")];
      expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual(Object.keys(GROUPS));
      for (const group of groups) {
        const name = group.querySelector("h3")?.textContent as keyof typeof GROUPS;
        const keys = [...group.querySelectorAll("[data-key]")]
          .filter((row) => row.getAttribute("data-key") !== "test-lock")
          .map((row) => row.getAttribute("data-key"));
        expect(keys, `${repo} ${name}`).toEqual([...GROUPS[name]]);
      }
      for (const row of document.querySelectorAll("[data-key]")) {
        const source = row.getAttribute("data-source") ?? "";
        expect(SOURCES, `${repo} ${row.getAttribute("data-key")}`).toContain(source);
        const [text, title] = BADGES[source] as [string, string];
        const badge = row.querySelector(".src");
        expect(badge?.textContent).toMatch(new RegExp(`^${text}`));
        expect(badge?.getAttribute("title")).toBe(title);
        const edit = row.querySelector("[data-edit]");
        if (source === "repo" || source === "builtin") expect(edit).toBeNull();
        if (source === "default") expect(edit).not.toBeNull();
      }
    }
    const app = render("?repo=demo-app");
    for (const key of ["hard_rules", "areas"])
      expect(app.querySelector(`[data-key="${key}"]`)?.getAttribute("data-source")).toBe("repo");
    expect(app.querySelector('[data-key="checks"] .src')?.textContent).toContain("Repo file wins");
    const site = render("?repo=demo-site");
    expect(site.querySelector('[data-key="hard_rules"]')?.getAttribute("data-source")).not.toBe(
      "repo",
    );
    for (const button of render().querySelectorAll("[data-save]"))
      expect(button.getAttribute("data-write")).toBe("needs-build");
  });

  it("keeps Authority read-only with the reason", () => {
    const document = render();
    for (const key of ["autonomy", "flight_powers"]) {
      const row = document.querySelector(`[data-key="${key}"]`);
      expect(row?.querySelector("[data-edit]")).toBeNull();
      expect(row?.textContent).toContain("Only config.yaml sets this. A change restarts FLIGHT.");
    }
  });

  it("edits inline, refuses what the schema refuses, and writes nothing", () => {
    const document = render("?repo=demo-site");
    const window = document.defaultView as unknown as Window & typeof globalThis;
    const row = document.querySelector('[data-key="checks"]');
    row?.querySelector<HTMLElement>("[data-edit]")?.click();
    const input = row?.querySelector<HTMLInputElement>("input");
    const order = [...(row?.querySelectorAll(".editor *") ?? [])].map((e) => e.tagName);
    expect(order.lastIndexOf("BUTTON")).toBeGreaterThan(order.indexOf("INPUT"));
    if (!input) throw new Error("no editor field");
    input.value = "pnpm -s lint && pnpm -s test";
    row?.querySelector<HTMLElement>("[data-add]")?.click();
    expect(row?.querySelector(".field-error")?.textContent).toBe(
      "must be one plain command: no &&, |, ; or line break",
    );
    expect(input.value).toBe("pnpm -s lint && pnpm -s test");
    row?.querySelector<HTMLElement>("[data-cancel]")?.click();
    expect(row?.querySelector(".editor")).toBeNull();
    const globs = document.querySelector('[data-key="uat.paths"]');
    globs?.querySelector<HTMLElement>("[data-edit]")?.click();
    const gi = globs?.querySelector<HTMLInputElement>("input");
    if (!gi) throw new Error("no editor field");
    gi.value = "a/**/b";
    globs?.querySelector<HTMLElement>("[data-add]")?.click();
    expect(globs?.querySelector(".field-error")?.textContent).toBe("`**` only as a trailing /**");
    gi.value = "docs/**";
    globs?.querySelector<HTMLElement>("[data-add]")?.click();
    globs?.querySelector<HTMLElement>("[data-save]")?.click();
    expect(document.querySelector("#status")?.textContent).toContain(
      "Saved. Mission Control kept a backup of config.yaml.",
    );
    expect(window.fetch).toBeUndefined();
  });

  it("fails the next save under conflict and keeps the draft", () => {
    const document = render("?state=conflict");
    const row = document.querySelector('[data-key="uat.labels"]');
    row?.querySelector<HTMLElement>("[data-edit]")?.click();
    const input = row?.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("no editor field");
    input.value = "ui";
    row?.querySelector<HTMLElement>("[data-add]")?.click();
    row?.querySelector<HTMLElement>("[data-save]")?.click();
    expect(row?.querySelector(".field-error, .save-error")?.textContent).toBe(
      "config.yaml changed since this page loaded. Reload and try again.",
    );
    expect(row?.querySelector(".editor")?.textContent).toContain("ui");
  });

  it("lists every built-in guard rule", () => {
    const document = render();
    const rows = [...document.querySelectorAll("#guard [data-rule]")];
    expect(rows.map((r) => r.querySelector(".rule")?.textContent)).toEqual(
      Object.values(GUARD_RULES),
    );
    expect(rows).toHaveLength(13);
    expect(document.querySelector("#guard")?.textContent).toContain(GUARD_NOTE);
    expect(document.querySelector("#guard")?.textContent).toContain(
      "Hard stops in code · refusals in the last 7 days",
    );
    for (const row of rows) {
      expect(row.querySelector("a[data-guard-drawer]")).not.toBeNull();
      expect(row.querySelector(".rule")?.getAttribute("title")).toBe(
        row.querySelector(".rule")?.textContent,
      );
    }
    const unknown = render("?state=disconnected");
    expect(unknown.querySelector("#guard [data-rule] a")?.textContent).toBe("—");
  });

  it("lists the five built roles with their prompt headings in a drawer", () => {
    const document = render();
    const window = document.defaultView as unknown as Window & typeof globalThis;
    const rows = [...document.querySelectorAll("#roles tbody > tr:not([data-planned])")];
    expect(rows.map((r) => r.querySelector("[data-call]")?.textContent)).toEqual([
      "FLIGHT",
      "FAO",
      "GUIDO",
      "INCO",
      "RETRO",
    ]);
    expect(document.querySelector("details summary")?.textContent).toBe("Planned roles");
    const button = rows[3]?.querySelector<HTMLButtonElement>("[data-prompt]");
    expect(button?.textContent).toBe("Read prompt");
    button?.focus();
    button?.click();
    const drawer = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(drawer?.hidden).toBe(false);
    const role = readFileSync(join(root, "roles/INCO.md"), "utf8");
    for (const [, heading] of role.matchAll(/^## (.+)$/gm))
      expect(drawer?.textContent).toContain(heading);
    expect(drawer?.textContent).toContain(
      "Role prompts are protected files. Change one with a reviewed PR.",
    );
    expect(drawer?.querySelector("button[data-write]")?.getAttribute("data-write")).toBe(
      "needs-build",
    );
    drawer?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer?.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("words each state", () => {
    const text: Record<string, RegExp> = {
      loading: /Reading the repo's rules…/,
      error: /Rules did not load\./,
      stale: /Figures are \d+ min old\./,
      disconnected: /Not connected to the hub\. These rules are from \d\d:\d\d\./,
    };
    for (const state of STATES) {
      const document = render(`?state=${state}`);
      if (text[state]) expect(wordsOf(document), state).toMatch(text[state]);
    }
    const error = render("?state=error");
    expect(error.querySelector("[data-retry]")?.textContent).toBe("Try again");
    const empty = render("?state=empty");
    for (const row of empty.querySelectorAll("[data-key]"))
      if (!["autonomy", "flight_powers", "test-lock"].includes(row.getAttribute("data-key") ?? ""))
        expect(row.getAttribute("data-source")).toBe("default");
    expect(wordsOf(empty)).toContain("No refusals in the last 7 days.");
    const long = render("?state=long");
    expect(long.querySelectorAll('[data-key="uat.labels"] .chip').length).toBeGreaterThan(0);
  });

  it("uses no real repo names, paths or people", () => {
    expect(mockup).not.toMatch(/mission-control|Luke-Bradford|\/Users\/|C:\\/i);
    expect(mockup).toContain("demo-app");
    expect(mockup).toContain("demo-site");
  });
});

describe("Setup Roles & guards mockup README", () => {
  it("states that it waits for the operator", () => {
    const banner = "Proposal mockup. Repos, rules and counts are fictional.";
    expect(render().querySelector(".banner")?.textContent).toBe(banner);
    expect(readme).toContain("Approval: waiting for the operator.");
    const section = readme.split(/^## Build tickets$/m)[1] ?? "";
    expect(section).toMatch(/^### Server: write repo rules$/m);
    expect(section).toMatch(/^### Web: Roles & guards page$/m);
    for (const part of section.split(/^### /m).slice(1)) {
      expect(part).toMatch(/Done when/);
      expect(part).toMatch(/Size/);
    }
  });

  it("lists every key and asks the one question", () => {
    for (const keys of Object.values(GROUPS))
      for (const key of keys) expect(readme, key).toContain(`\`${key}\``);
    expect(readme).toContain("Should Authority stay read-only on this page?");
    expect(readme).toMatch(/Refusals/);
    expect(readme).toMatch(/Seats/);
  });
});

describe("the page register", () => {
  const spec = readFileSync(join(root, "docs/superpowers/specs/2026-10-25-site-review.md"), "utf8");
  it("links a design for every page", () => {
    const section = spec.split("## Page register: where each page's design lives")[1] ?? "";
    expect(section.length).toBeGreaterThan(0);
    const rows = section
      .split(/\n(?=#{1,3} )/)[0]
      ?.split("\n")
      .filter((l) => l.startsWith("|")) as string[];
    const cells = (l: string) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
    expect(cells(rows[0] ?? "")).toEqual(["Page", "Design", "Approval", "Build"]);
    const body = rows.slice(2).map(cells);
    expect(body.map((r) => r[0])).toEqual(PAGES);
    for (const r of body) {
      const links = [...(r[1] ?? "").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
      expect(links.length, r[0]).toBeGreaterThan(0);
      for (const link of links) {
        const target = resolve(dirname(join(root, "docs/superpowers/specs/x.md")), link ?? "");
        expect(() => readFileSync(target), `${r[0]} ${link}`).not.toThrow();
      }
      expect(r[2]?.length).toBeGreaterThan(0);
      expect(r[3]?.length).toBeGreaterThan(0);
    }
  });

  it("the FLIGHT spec names the built tabs", () => {
    const flight = readFileSync(
      join(root, "docs/superpowers/specs/2026-10-27-flight-central-mind-design.md"),
      "utf8",
    );
    for (const label of Object.values(TAB_LABEL)) expect(flight).toContain(label);
    expect(flight).toContain("the page layout below is history");
  });
});
