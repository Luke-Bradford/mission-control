import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigView,
  GUARD_NOTE,
  GUARD_RULES,
  type GuardHitsView,
  LOCK_FREE_TEXT,
  type TestLockState,
} from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup } from "../src/pages/Setup.tsx";
import { editSeatParam } from "../src/router.ts";
import { SEATS_RULE_LINE } from "../src/setup/Roles.tsx";
import { EDIT_SOON, RULE_GROUPS } from "../src/setup/repoRules.ts";
import { ROLE_HEADINGS } from "../src/setup/roleHeadings.ts";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG, REPOS } from "./fixtures.ts";
import { rulesFixture } from "./rolesRulesFixture.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FREE: TestLockState = { holder: null, waiting: [] };
const NO_HITS: GuardHitsView = {
  hits: [],
  counts: Object.fromEntries(
    Object.keys(GUARD_RULES).map((r) => [r, 0]),
  ) as GuardHitsView["counts"],
};
const CFG: ConfigView = CREW_CONFIG;
const REPO = CFG.repos[0]?.id as string;

function load(over: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/config": CFG,
    "/api/settings/crew-pause": null,
    "/api/repos": REPOS,
    "/api/test-lock": FREE,
    "/api/guard/hits?days=7": NO_HITS,
    [`/api/repos/${REPO}/rules`]: rulesFixture(REPO),
    ...over,
  });
}

function page() {
  window.history.replaceState(null, "", "/setup/roles");
  return render(<Setup tab="roles" />);
}

/** The Repo rules panel once its rows are in (the page swaps it in when the config arrives). */
async function rulesPanel(): Promise<HTMLElement> {
  await screen.findByText("pick_from");
  return screen.getByRole("region", { name: "Repo rules" });
}

describe("Setup › Roles & guards", () => {
  it("Repo rules: 17 keys in 5 groups, each with its source badge, every Edit off", async () => {
    load();
    page();
    const rules = await rulesPanel();
    expect(RULE_GROUPS).toHaveLength(5);
    expect(RULE_GROUPS.flatMap((g) => g.rules as readonly unknown[])).toHaveLength(17);
    expect(
      rules.querySelectorAll("[data-source][data-key]:not([data-key=test-lock])"),
    ).toHaveLength(17);
    expect(within(rules).getByText("Repo file wins")).toBeTruthy();
    expect(within(rules).getAllByText("Config file")).toHaveLength(2);
    expect(
      within(rules).getAllByText("Only config.yaml sets this. A change restarts FLIGHT."),
    ).toHaveLength(2);
    // the repo file's additions show as dashed chips beside the user's own
    const checks = rules.querySelector("[data-key=checks]") as HTMLElement;
    expect(within(checks).getByText("pnpm -s test:related").parentElement?.className).toContain(
      "repo",
    );
    const edits = within(rules).getAllByRole("button", { name: /^Edit / });
    expect(edits.length).toBeGreaterThan(0);
    for (const b of edits) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute("title")).toBe(EDIT_SOON);
    }
    // a key the repo file sets, or only config.yaml sets, has no Edit
    expect(
      within(rules.querySelector("[data-key=areas]") as HTMLElement).queryByRole("button", {
        name: /Edit/,
      }),
    ).toBeNull();
    expect(
      within(rules.querySelector("[data-key=autonomy]") as HTMLElement).queryByRole("button", {
        name: /Edit/,
      }),
    ).toBeNull();
  });

  it("Repo rules: reads the repo's rules before the route answers, and says so when it fails", async () => {
    load({ [`/api/repos/${REPO}/rules`]: () => ({ status: 500, body: { error: "boom" } }) });
    page();
    expect((await screen.findByRole("region", { name: "Repo rules" })).textContent).toContain(
      "Reading the repo's rules",
    );
    await screen.findByText(/Rules did not load/);
  });

  it("Built-in guard: each stop with its 7-day count, the note, and — when unreachable", async () => {
    load({
      "/api/guard/hits?days=7": { ...NO_HITS, counts: { ...NO_HITS.counts, "git-write": 3 } },
    });
    page();
    const guard = await screen.findByRole("region", { name: "Built-in guard" });
    await waitFor(() => expect(guard.textContent).toContain("3"));
    const row = guard.querySelector("[data-rule=git-write]") as HTMLElement;
    expect(row.textContent).toBe(`${GUARD_RULES["git-write"]}3 refusals`);
    expect(guard.querySelectorAll("[data-rule]")).toHaveLength(Object.keys(GUARD_RULES).length);
    expect(within(guard).getByText(GUARD_NOTE)).toBeTruthy();
  });

  it("Built-in guard: shows — for each count when the hub cannot be read", async () => {
    load({ "/api/guard/hits?days=7": () => ({ status: 500, body: {} }) });
    page();
    const down = await screen.findByRole("region", { name: "Built-in guard" });
    await new Promise((r) => setTimeout(r, 50));
    expect((down.querySelector("[data-rule=git-write] .rg-count") as HTMLElement).textContent).toBe(
      "— refusals, unknown",
    );
  });

  it("Repo rules: the test lock sits under Checks with its policy and holder lines", async () => {
    load();
    page();
    const rules = await rulesPanel();
    const lock = await waitFor(() => {
      const el = rules.querySelector("[data-key=test-lock]") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(lock.textContent).toContain("One full suite at a time across the machine");
    expect(lock.textContent).toContain("Single-file runs go straight through.");
    await within(lock).findByText(LOCK_FREE_TEXT);
  });

  it("Roles: each role lists its seats with file areas and an Edit link to its Sessions form", async () => {
    load();
    page();
    const roles = await screen.findByRole("region", { name: "Roles" });
    expect(within(roles).getByText(SEATS_RULE_LINE)).toBeTruthy();
    const seat = CFG.crew?.sessions[0]?.seats.find((s) => s.role === "GUIDO");
    expect(seat).toBeTruthy();
    const row = await waitFor(() => {
      const r = roles.querySelector("[data-role=GUIDO]") as HTMLElement;
      expect(r.textContent).toContain(`${String(seat?.id).toUpperCase()}:`);
      return r;
    });
    expect(row.textContent).toContain(seat?.area.join(", ") ?? "whole checkout");
    const edit = within(row).getByRole("link", { name: /^Edit .* on Sessions$/ });
    const href = edit.getAttribute("href") as string;
    expect(href.startsWith("/setup/sessions?edit=")).toBe(true);
    expect(editSeatParam(href.slice(href.indexOf("?")))).toEqual({
      sessionId: CFG.crew?.sessions[0]?.id,
      seatId: seat?.id,
    });
    expect(
      within(row)
        .getByRole("link", { name: /seats?$/ })
        .getAttribute("href"),
    ).toBe("/setup/sessions");
    // a role with no seat says so
    expect(
      within(roles.querySelector("[data-role=FAO]") as HTMLElement).getByText("No seats"),
    ).toBeTruthy();
  });

  it("Roles: Planned roles opens and closes, with the arrow's state in the summary", async () => {
    load();
    page();
    const roles = await screen.findByRole("region", { name: "Roles" });
    const details = roles.querySelector("details.rg-planned") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll("[data-planned]")).toHaveLength(4);
    details.open = true;
    expect(details.hasAttribute("open")).toBe(true);
  });

  it("Roles: the prompt drawer holds focus, closes on Escape and returns focus", async () => {
    load();
    page();
    const roles = await screen.findByRole("region", { name: "Roles" });
    const open = within(roles.querySelector("[data-role=RETRO]") as HTMLElement).getByRole(
      "button",
      {
        name: "Read prompt",
      },
    );
    open.focus();
    fireEvent.click(open);
    const drawer = screen.getByRole("dialog", { name: "RETRO prompt" });
    const close = within(drawer).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    for (const h of ROLE_HEADINGS.RETRO ?? []) expect(within(drawer).getByText(h)).toBeTruthy();
    // the one control: Tab and Shift+Tab stay on it
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("the drawer's headings match each role's prompt file", () => {
    for (const [role, headings] of Object.entries(ROLE_HEADINGS)) {
      const text = readFileSync(join(__dirname, "../../../roles", `${role}.md`), "utf8");
      const found = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect([...headings]).toEqual(found);
    }
  });
});
