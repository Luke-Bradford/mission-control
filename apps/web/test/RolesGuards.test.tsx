import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigView,
  GUARD_NOTE,
  GUARD_RULES,
  type GuardHitsView,
  LOCK_FREE_TEXT,
  type RepoRulesView,
  type TestLockState,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
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
  vi.restoreAllMocks();
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

type Answer = { status: number; body: unknown };
/** A route that answers only when the test says so. */
function held(): { route: () => Promise<Answer>; answer: (a: Answer) => Promise<void> } {
  let release: (a: Answer) => void = () => {};
  const wait = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  return {
    route: () => wait,
    answer: async (a) => {
      await act(async () => {
        release(a);
        await wait;
        await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
}

/** A second repo, with an id the route must encode, and rules unlike the first repo's. */
const OTHER = "site builder";
const OTHER_ROUTE = `/api/repos/${encodeURIComponent(OTHER)}/rules`;
const TWO_REPOS: ConfigView = {
  ...CFG,
  repos: CFG.repos.slice(0, 2).map((r, i) => (i === 1 ? { ...r, id: OTHER } : r)),
};
const OTHER_RULES: RepoRulesView = {
  base: `sha-${OTHER}`,
  rules: {
    ...rulesFixture(OTHER).rules,
    pick_from: { source: "set-here", value: ["Todo"] },
    areas: { source: "default", value: {} },
  },
};
const row = (panel: HTMLElement, key: string) =>
  panel.querySelector(`[data-key="${key}"]`) as HTMLElement;

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

  it("Repo rules: says to add a repo when none is configured, and asks for nothing", async () => {
    const fetch = load({ "/api/config": { ...CFG, repos: [] } });
    page();
    await screen.findByText("Add a repo to see its rules.");
    expect(fetch.mock.calls.some(([p]) => String(p).includes("/rules"))).toBe(false);
  });

  it("Repo rules: shows a record, a boolean and a word as chips, and says when the repo file was not read", async () => {
    load({
      [`/api/repos/${REPO}/rules`]: {
        ...rulesFixture(REPO),
        repoFileError: "CLAUDE.md block is invalid",
      },
    });
    page();
    const rules = await rulesPanel();
    const areas = rules.querySelector("[data-key=areas]") as HTMLElement;
    expect(within(areas).getByText("web: apps/web/**")).toBeTruthy();
    const promote = rules.querySelector("[data-key=promote_backlog]") as HTMLElement;
    expect(within(promote).getByText("Off")).toBeTruthy();
    const autonomy = rules.querySelector("[data-key=autonomy]") as HTMLElement;
    expect(within(autonomy).getByText("draft")).toBeTruthy();
    expect(rules.textContent).toContain(
      "The repo file's rules are not shown. CLAUDE.md block is invalid",
    );
  });

  it("Repo rules: keeps the last rules and warns when a refresh fails", async () => {
    let fail = false;
    load({
      [`/api/repos/${REPO}/rules`]: () =>
        fail ? { status: 500, body: { error: "boom" } } : { status: 200, body: rulesFixture(REPO) },
    });
    page();
    await rulesPanel();
    fail = true;
    act(() => hub.refetchTopic("config"));
    await screen.findByText(/Refreshing them failed/);
    expect(screen.getByText("pick_from")).toBeTruthy();
  });

  it("Repo rules: the Repo picker reads the chosen repo, and its rules replace the first repo's", async () => {
    const other = held();
    const fetch = load({ "/api/config": TWO_REPOS, [OTHER_ROUTE]: other.route });
    page();
    let rules = await rulesPanel();
    expect(rules.textContent).toContain(`${REPO} · repo file read`);
    expect(row(rules, "pick_from").dataset.source).toBe("repo-file");
    expect(within(row(rules, "pick_from")).getByText("In review")).toBeTruthy();
    expect(within(row(rules, "areas")).getByText("web: apps/web/**")).toBeTruthy();
    expect(fetch.mock.calls.some(([p]) => p === OTHER_ROUTE)).toBe(false);

    fireEvent.change(within(rules).getByRole("combobox"), { target: { value: OTHER } });
    // the second repo is read by its encoded id, and the first repo's rows leave while it loads
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(OTHER_ROUTE, expect.anything()));
    rules = screen.getByRole("region", { name: "Repo rules" });
    expect(rules.textContent).toContain("Reading the repo's rules");
    expect(row(rules, "pick_from")).toBeNull();
    expect(within(rules).queryByText("In review")).toBeNull();

    await other.answer({ status: 200, body: OTHER_RULES });
    rules = await rulesPanel();
    expect(rules.textContent).toContain(`${OTHER} · repo file read`);
    expect(row(rules, "pick_from").dataset.source).toBe("set-here");
    expect(within(row(rules, "pick_from")).getByText("Todo")).toBeTruthy();
    expect(within(rules).queryByText("In review")).toBeNull();
    expect(row(rules, "areas").dataset.source).toBe("default");
    expect(within(row(rules, "areas")).getByText("None set")).toBeTruthy();
    expect(within(rules).queryByText("Repo file wins")).toBeNull();
    expect((within(rules).getByRole("combobox") as HTMLSelectElement).value).toBe(OTHER);

    // back to the first repo: its own values and sources return
    fireEvent.change(within(rules).getByRole("combobox"), { target: { value: REPO } });
    await waitFor(() =>
      expect(
        row(screen.getByRole("region", { name: "Repo rules" }), "pick_from")?.dataset.source,
      ).toBe("repo-file"),
    );
    expect(screen.getByText("In review")).toBeTruthy();
  });

  it("Repo rules: a chosen repo whose rules fail shows its own error, not the first repo's rules", async () => {
    load({
      "/api/config": TWO_REPOS,
      [OTHER_ROUTE]: () => ({ status: 500, body: { error: "boom" } }),
    });
    page();
    const rules = await rulesPanel();
    fireEvent.change(within(rules).getByRole("combobox"), { target: { value: OTHER } });
    await screen.findByText(/Rules did not load/);
    const after = screen.getByRole("region", { name: "Repo rules" });
    expect(after.textContent).toContain(OTHER);
    expect(row(after, "pick_from")).toBeNull();
    expect(within(after).queryByText("In review")).toBeNull();
  });

  it("Repo rules: a value its column cuts short is a button that shows it in full", async () => {
    const long = `apps/${"a-very-long-folder-name/".repeat(12)}file.ts`;
    // jsdom lays nothing out: say every chip's text is wider than its box
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    load({
      [`/api/repos/${REPO}/rules`]: {
        ...rulesFixture(REPO),
        rules: {
          ...rulesFixture(REPO).rules,
          protected: { source: "set-here", value: [long] },
        },
      },
    });
    page();
    const rules = await rulesPanel();
    const chip = await within(row(rules, "protected")).findByRole("button", { name: long });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.className).not.toContain("open");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.className).toContain("open");
    expect(chip.textContent).toBe(long);
    // a value the repo file added says so in words, and keeps its dashed look when open
    const added = await within(row(rules, "checks")).findByRole("button", {
      name: "pnpm -s test:related, added by the repo file",
    });
    fireEvent.click(added);
    expect(added.className).toContain("repo");
    expect(added.className).toContain("open");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("Repo rules: a value that fits is plain text with no control of its own", async () => {
    load();
    page();
    const rules = await rulesPanel();
    expect(within(row(rules, "protected")).getByText(".github/**")).toBeTruthy();
    expect(within(row(rules, "protected")).queryAllByRole("button", { name: /github/ })).toEqual(
      [],
    );
    expect(rules.querySelectorAll("button.rg-chip")).toHaveLength(0);
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

  it("Roles: says the seats are being read until the config answers, never that a role has none", async () => {
    const config = held();
    load({ "/api/config": config.route });
    page();
    const roles = await screen.findByRole("region", { name: "Roles" });
    for (const role of ["FLIGHT", "FAO", "GUIDO", "INCO", "RETRO"]) {
      const r = roles.querySelector(`[data-role=${role}]`) as HTMLElement;
      expect(within(r).getByText("Reading seats…")).toBeTruthy();
      expect(r.querySelector(".rg-mid")?.textContent).toBe("— seats, unknown");
    }
    expect(roles.textContent).not.toContain("0 seats");
    expect(roles.textContent).not.toContain("No seats");
    expect(screen.getByRole("region", { name: "Repo rules" }).textContent).toContain(
      "Reading the repo's rules",
    );

    await config.answer({ status: 200, body: CFG });
    await waitFor(() =>
      expect((roles.querySelector("[data-role=GUIDO]") as HTMLElement).textContent).toContain(
        "1 seat",
      ),
    );
    // only now may a role say it has no seats
    const fao = roles.querySelector("[data-role=FAO]") as HTMLElement;
    expect(within(fao).getByText("No seats")).toBeTruthy();
    expect(within(fao).getByRole("link", { name: "0 seats" })).toBeTruthy();
    expect(roles.textContent).not.toContain("Reading seats");
  });

  it("Roles and Repo rules: say the config did not load, never that a role has no seats", async () => {
    load({ "/api/config": () => ({ status: 500, body: { error: "boom" } }) });
    page();
    const roles = await screen.findByRole("region", { name: "Roles" });
    expect((await within(roles).findByRole("alert")).textContent).toMatch(/^Seats did not load\. /);
    for (const role of ["FLIGHT", "FAO", "GUIDO", "INCO", "RETRO"]) {
      const cells = roles.querySelectorAll(`[data-role=${role}] td`);
      expect(cells[3]?.textContent).toBe("— seats, unknown");
      expect(cells[4]?.textContent).toBe("— unknown");
    }
    expect(roles.textContent).not.toContain("0 seats");
    expect(roles.textContent).not.toContain("No seats");
    expect(roles.textContent).not.toContain("Reading seats");
    const rules = screen.getByRole("region", { name: "Repo rules" });
    expect(within(rules).getByRole("alert").textContent).toMatch(/^Rules did not load\. /);
    expect(rules.textContent).not.toContain("Reading the repo's rules");
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
