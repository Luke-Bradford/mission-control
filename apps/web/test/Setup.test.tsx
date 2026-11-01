import {
  type ConfigView,
  type Crew,
  type CrewChanges,
  FREE_SUITE_HINT,
  GITHUB_SLOWED_PREFIX,
  GUARD_NOTE,
  GUARD_RULES,
  type GuardHitsView,
  type GuardRule,
  type HealthRow,
  type LimitRow,
  LOCK_FREE_TEXT,
  LOCK_WAIT_MS,
  type MapSnapshot,
  mapSnapshotFixture,
  PREVIEW_SERVER,
  RETRY_NOTE,
  type RepoPreview,
  ROLES,
  type TestLockState,
  UP_TO_DATE_MAIN,
  UPDATE_UNAVAILABLE,
  type VersionInfo,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Setup } from "../src/pages/Setup.tsx";
import { SETUP_TABS, type SetupTab } from "../src/router.ts";
import {
  addedText,
  FOLDER_FREE,
  loadErrorText,
  RELOADED,
  refusedText,
  removedText,
  restartText,
  SAVE_NOTE,
  SCRATCH_LABEL,
  SESSIONS_NOTE,
  savedText,
} from "../src/setup/Sessions.tsx";
import { setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import {
  CONFIG,
  CREW_CONFIG,
  crewRow,
  GITHUB_RATE,
  GITHUB_RATE_LINE,
  HOUR,
  limit5h,
  limit7d,
  MIN,
  NOW,
  REPOS,
  SESSION_CONFIG,
  seatRow,
} from "./fixtures.ts";

const CFG: ConfigView = {
  ...CONFIG,
  loops: [
    ...CONFIG.loops,
    {
      id: "studio",
      repoId: "site-builder",
      kind: "studio-loop",
      accountId: "codex-main",
      stateDir: "/u/studio/var",
      logsDir: null,
      worktree: "/u/studio",
      launchdLabel: "com.studio.loop",
    },
  ],
};

const CREW: Crew = {
  rows: [
    crewRow(),
    crewRow({ id: "studio", repoId: "site-builder", index: 1, hudState: "idle", run: null }),
  ],
  firstRunToday: null,
};

const health = (over: Partial<HealthRow> & Pick<HealthRow, "collector">): HealthRow => ({
  ok: true,
  error: null,
  at: NOW,
  lastOkAt: NOW - 5 * MIN,
  ...over,
});

const HEALTH: HealthRow[] = [
  health({ collector: "github:shop-app" }),
  health({ collector: "github:shop-app:prs", error: "2 PRs skipped" }),
  health({ collector: "flow:shop-app", error: "history is short" }),
  health({ collector: "github:site-builder", lastOkAt: null, ok: true }),
];

const LIMITS: LimitRow[] = [
  limit5h({ used: 38.4 }),
  limit7d({ accountId: "claude-main", used: 80.2 }),
  limit5h({ accountId: "codex-main", used: 99.6 }),
  limit7d({ accountId: "codex-main", used: 100.4, resetAt: NOW + HOUR }),
];

let fetchFn: ReturnType<typeof stubFetch>;
function load(over: Record<string, unknown> = {}) {
  fetchFn = stubFetch({
    "/api/config": CFG,
    "/api/crew?shape=summary": CREW,
    "/api/limits": LIMITS,
    "/api/health": HEALTH,
    "/api/repos": REPOS,
    "/api/accounts/models": [
      { accountId: "claude-main", models: [{ model: "sonnet", efforts: ["low", "medium"] }] },
      { accountId: "codex-main", models: [{ model: "gpt-6-astra", efforts: ["low", "high"] }] },
    ],
    ...over,
  });
}

function at(tab: SetupTab) {
  window.history.replaceState(null, "", `/setup/${tab}`);
  return render(<Setup tab={tab} />);
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOW }));
afterEach(() => vi.useRealTimers());

describe("Setup tabs", () => {
  it("the dependency-order sidebar routes its six sections", async () => {
    load();
    render(<Setup tab="sessions" />);
    const tabs = screen.getByRole("navigation", { name: "Setup sections" });
    expect(SETUP_TABS).toHaveLength(7);
    fireEvent.click(within(tabs).getByRole("button", { name: "Accounts" }));
    expect(window.location.pathname).toBe("/setup/accounts");
    fireEvent.click(within(tabs).getByRole("button", { name: "Roles" }));
    expect(window.location.pathname).toBe("/setup/roles");
    fireEvent.click(within(tabs).getByRole("button", { name: "Sources" }));
    expect(window.location.pathname).toBe("/setup/sources");
    fireEvent.click(within(tabs).getByRole("button", { name: "Safety" }));
    expect(window.location.pathname).toBe("/setup/access");
  });

  it("Sessions marks stray folder tiles with file and time for this session", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew/sessions": sessionsOf([
        { name: "docs", owners: [] },
        { name: "apps", owners: [] },
      ]),
      "/api/attention": [
        {
          kind: "stray",
          key: "stray:a",
          text: "docs/guide.md changed in s/s1 outside every agent's area",
          path: "docs/guide.md",
          sessionId: "s1",
          at: NOW,
        },
        {
          kind: "stray",
          key: "stray:b",
          text: "apps/other.ts changed in s/s2 outside every agent's area",
          path: "apps/other.ts",
          sessionId: "s2",
          at: NOW,
        },
      ],
    });
    at("sessions");
    const p = await screen.findByRole("region", { name: "s/s1" });
    const stray = await within(p).findByText("Stray change");
    expect(stray.closest("li")?.textContent).toContain("docs/guide.md · 13:00");
    expect(p.textContent).not.toContain("apps/other.ts");
  });

  it("Sessions: a panel per repo with the crew and the branch, filtered by session", async () => {
    load();
    at("sessions");
    expect(await screen.findByText(SESSIONS_NOTE)).toBeTruthy();
    const p = await screen.findByRole("region", { name: "shop-app · observed loops" });
    expect(p.textContent).toContain("octo-org/shop-app · feature/3349-quote-cache");
    const btn = within(p).getByRole("button", { name: /shop-app-ta/ });
    expect(btn.textContent).toContain("observed loop");
    expect(btn.textContent).toContain("Running");
    fireEvent.click(btn);
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
    const other = screen.getByRole("region", { name: "site-builder · observed loops" });
    expect(other.textContent).toContain("octo-org/site-builder · —");
    expect(screen.getByRole("button", { name: "Add session" })).toBeTruthy();
  });

  it("Sessions and Loops hide what is outside the selected session", async () => {
    load({ "/api/config": { ...SESSION_CONFIG, loops: CFG.loops } });
    setSession("shop-app-session");
    at("sessions");
    await screen.findByRole("region", { name: "shop-app · observed loops" });
    expect(screen.queryByRole("region", { name: "site-builder · observed loops" })).toBeNull();
    cleanupAndAt("loops");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("com.shop-app.ta-loop")).toBeTruthy();
    expect(within(table).queryByText("com.studio.loop")).toBeNull();
  });

  it("Loops: the observed loops and the templates note", async () => {
    load();
    at("loops");
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Loop", "Kind", "Repo", "Account", "launchd label", "Worktree"]);
    expect(within(table).getByText("/u/studio")).toBeTruthy();
    const t = screen.getByRole("region", { name: "Templates" });
    expect(t.textContent).toContain("This server reads no template profiles.");
    expect(t.textContent).toContain(RETRY_NOTE);
    expect(t.textContent).toContain(
      "Mission Control decides every move from its own checks; an agent saying it is done can only hold work back, never push it forward. cmd = Mission Control runs it · rule = read from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent = the agent's own evidence.",
    );
    expect(screen.queryByRole("region", { name: "GitHub" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Microsoft Teams" })).toBeNull();
  });

  const SESSIONS_CFG: ConfigView = { ...CREW_CONFIG, loops: CFG.loops };
  const sessionsOf = (folders: unknown) => [{ id: "s1", readable: true, folders }];
  const GUIDO_SEAT = {
    id: "guido-1",
    role: "GUIDO",
    accountId: "claude-main",
    model: "sonnet",
    area: ["apps/**"],
  };
  const RETRO_SEAT = {
    id: "retro-1",
    role: "RETRO",
    accountId: "claude-main",
    model: "sonnet",
    area: [],
  };
  const CHANGES: CrewChanges = {
    sessions: [{ id: "s1", seats: [GUIDO_SEAT, RETRO_SEAT] }],
    pending: [],
    restartNeeded: [],
    error: null,
    checkedAt: NOW,
  };

  it("Sessions: stray tiles use the path and session, independent of display text", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew/sessions": sessionsOf([
        { name: "apps", owners: [] },
        { name: "docs", owners: [] },
      ]),
      "/api/attention": [
        {
          key: "stray:1",
          kind: "stray",
          path: "apps/a.ts",
          sessionId: "s1",
          text: "unrelated display text",
          at: NOW,
        },
        {
          key: "stray:2",
          kind: "stray",
          path: "docs/b.md",
          sessionId: "other",
          text: "docs/b.md changed in s/s1 outside every agent's area",
          at: NOW,
        },
      ],
    });
    at("sessions");
    const p = await screen.findByRole("region", { name: "s/s1" });
    expect(await within(p).findByText("Stray change")).toBeTruthy();
    expect(within(p).getByText(/apps\/a.ts ·/)).toBeTruthy();
    expect(within(p).queryByText(/docs\/b.md/)).toBeNull();
    expect(within(p).getAllByText("Stray change")).toHaveLength(1);
  });

  it("a scratch seat's area says scratch review copy", async () => {
    const session = CREW_CONFIG.crew?.sessions[0];
    const retro = session?.seats[1];
    if (!CREW_CONFIG.crew || !session || !retro) throw new Error("fixture has no retro seat");
    load({
      "/api/config": {
        ...SESSIONS_CFG,
        crew: {
          ...CREW_CONFIG.crew,
          sessions: [{ ...session, seats: [{ ...retro, mode: "scratch" }] }],
        },
      },
      "/api/crew?shape=summary": {
        rows: [seatRow({ id: "retro-1", role: "RETRO", mode: "scratch", area: [] })],
        firstRunToday: null,
      },
      "/api/crew/sessions": sessionsOf([]),
    });
    at("sessions");
    const p = await screen.findByRole("region", { name: "s/s1" });
    expect(within(p).getByRole("button", { name: /retro-1/ }).textContent).toContain(
      "scratch review copy",
    );
  });

  it("Sessions: a panel per crew session with seats, area or read-only, state, and folder owners", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew?shape=summary": {
        rows: [
          crewRow(),
          seatRow({ hudState: "running" }),
          seatRow({ id: "retro-1", role: "RETRO", mode: "read-only", area: [], hudState: "idle" }),
        ],
        firstRunToday: null,
      },
      "/api/crew/changes": CHANGES,
      "/api/crew/sessions": sessionsOf([
        { name: "apps", owners: ["guido-1", "guido-2"] },
        { name: "docs", owners: [] },
      ]),
    });
    at("sessions");
    const p = await screen.findByRole("region", { name: "s/s1" });
    expect(p.textContent).toContain("/mc/clone · octo-org/shop-app");
    const guido = within(p).getByRole("button", { name: /guido-1/ });
    expect(guido.textContent).toContain("apps/**");
    expect(guido.textContent).toContain("Running");
    const retro = within(p).getByRole("button", { name: /retro-1/ });
    expect(retro.textContent).toContain("read-only");
    fireEvent.click(guido);
    expect(window.location.pathname).toBe("/agent/guido-1");
    // a listitem takes no name from its content: find each tile by its text for screen readers
    const tileOf = async (text: string) => {
      const li = (await within(p).findByText(text)).closest("li");
      if (!li) throw new Error(`no tile reads ${text}`);
      return li;
    };
    const seenIn = (li: HTMLElement) => {
      const seen = li.querySelector<HTMLElement>("[aria-hidden='true']");
      if (!seen) throw new Error("the tile has no aria-hidden container");
      return seen;
    };
    const apps = await tileOf("apps/: guido-1, guido-2");
    expect(await within(p).findAllByRole("listitem")).toContain(apps);
    const appsHidden = apps.querySelector(".sr-only");
    if (!appsHidden) throw new Error("the tile has no sr-only text");
    expect(appsHidden.textContent).toBe("apps/: guido-1, guido-2");
    // what is seen is hidden from screen readers, so the run-together string is never read
    const seen = seenIn(apps);
    expect(within(seen).getByText("apps/")).toBeTruthy();
    expect(within(seen).getByText("guido-1")).toBeTruthy();
    expect(within(seen).getByText("guido-2")).toBeTruthy();
    // the tiles wrap inside the panel, and so does a tile with many owners
    expect(apps.closest("ul")?.classList.contains("wrap")).toBe(true);
    expect(seen.classList.contains("wrap")).toBe(true);
    const docsSeen = seenIn(await tileOf("docs/: free"));
    expect(within(docsSeen).getByText(FOLDER_FREE)).toBeTruthy();
    expect(within(docsSeen).getByText("docs/")).toBeTruthy();
    expect(p.textContent).toContain("Tiles show who owns each folder; areas can't overlap.");
    expect(within(p).getAllByRole("button", { name: "Add agent" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add session" })).toBeTruthy();
    // the repo's panel is its observed loops only: the seats are in the crew session's panel
    const loops = screen.getByRole("region", { name: "shop-app · observed loops" });
    expect(within(loops).getByRole("button", { name: /shop-app-ta/ })).toBeTruthy();
    expect(within(loops).queryByRole("button", { name: /guido-1|retro-1/ })).toBeNull();
  });

  it("Sessions: each seat shows model · effort · CLI version", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew?shape=summary": {
        rows: [
          seatRow({ cli: { version: "2.1.302", effort: "high" } }),
          seatRow({ id: "retro-1", role: "RETRO", mode: "read-only", area: [] }),
        ],
        firstRunToday: null,
      },
      "/api/crew/sessions": sessionsOf([]),
    });
    at("sessions");
    const p = await screen.findByRole("region", { name: "s/s1" });
    // the call sign alone is the name; the model line is the button's description
    const described = (b: HTMLElement) =>
      (b.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    const guido = within(p).getByRole("button", { name: /^guido-1$/ });
    expect(guido.textContent).toContain("claude-opus-4-1 · high · CLI 2.1.302");
    expect(described(guido)).toContain("claude-opus-4-1 · high · CLI 2.1.302");
    const retro = within(p).getByRole("button", { name: /^retro-1$/ });
    expect(described(retro)).toContain("claude-opus-4-1 · default");
  });

  it("Sessions: a repo with no observed loops has no loops panel; s/ names crew sessions only", async () => {
    load({
      "/api/config": { ...CREW_CONFIG, loops: [] },
      "/api/crew?shape=summary": { rows: [seatRow()], firstRunToday: null },
      "/api/crew/sessions": sessionsOf([]),
    });
    at("sessions");
    await screen.findByRole("region", { name: "s/s1" });
    expect(screen.queryByRole("region", { name: /observed loops/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "s/shop-app" })).toBeNull();
  });

  it("Sessions: says nothing about missing agents until the crew has loaded", async () => {
    load({ "/api/crew?shape=summary": { rows: [], firstRunToday: null } });
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetchFn.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/crew?shape=summary") await gate;
      return answer(...a);
    });
    at("sessions");
    await screen.findByRole("region", { name: "shop-app · observed loops" });
    expect(screen.queryByText("No agents yet.")).toBeNull();
    release();
    expect((await screen.findAllByText("No agents yet.")).length).toBeGreaterThan(0);
  });

  it("Sessions: says nothing about missing agents when the crew failed to load", async () => {
    load({ "/api/crew?shape=summary": () => ({ status: 500, body: { error: "boom" } }) });
    at("sessions");
    await screen.findByRole("region", { name: "shop-app · observed loops" });
    await settled(fetchFn, "/api/crew?shape=summary");
    expect(screen.queryByText("No agents yet.")).toBeNull();
  });

  it("Sessions: a checkout that cannot be read says so instead of showing no folders", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew/sessions": [{ id: "s1", readable: false, folders: [] }],
    });
    at("sessions");
    const p = await screen.findByRole("region", { name: "s/s1" });
    expect(await within(p).findByText("Could not read the checkout's folders.")).toBeTruthy();
    expect(within(p).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("Sessions: says when crew is off on this server, with the reason if there is one", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew/status": { enabled: false, note: "crew lock held by pid 123" },
    });
    at("sessions");
    expect((await screen.findByRole("status")).textContent).toBe(
      "Crew is off: crew lock held by pid 123",
    );
  });

  it("Sessions: crew off without a note says so plainly", async () => {
    load({ "/api/config": SESSIONS_CFG, "/api/crew/status": { enabled: false, note: null } });
    at("sessions");
    expect(await screen.findByText("Crew is off.")).toBeTruthy();
  });

  it("Sessions: says nothing about crew when it is on", async () => {
    load({ "/api/config": SESSIONS_CFG, "/api/crew/status": { enabled: true, note: null } });
    at("sessions");
    await screen.findByRole("region", { name: "s/s1" });
    await settled(fetchFn, "/api/crew/status");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.getElementById("page-setup")?.textContent).not.toContain("Crew is off");
  });

  it("Sessions: a server with no crew config does not say crew is off", async () => {
    load({ "/api/crew/status": { enabled: false, note: null } });
    at("sessions");
    await screen.findByRole("region", { name: "shop-app · observed loops" });
    await settled(fetchFn, "/api/crew?shape=summary");
    expect(fetchFn).not.toHaveBeenCalledWith("/api/crew/status", expect.anything());
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.getElementById("page-setup")?.textContent).not.toContain("Crew is off");
  });

  it("Accounts: CLI status overrides collector health and does not depend on a crew seat", async () => {
    load({
      "/api/accounts/status": [
        {
          accountId: "claude-main",
          status: "not-logged-in",
          checkedAt: NOW,
          plan: null,
          identity: null,
        },
        {
          accountId: "codex-main",
          status: "logged-in",
          checkedAt: NOW,
          plan: "pro",
          identity: "Fictional operator",
        },
      ],
      "/api/config": SESSIONS_CFG,
      "/api/health": [
        health({ collector: "usage:claude-main" }),
        health({ collector: "usage:codex-main" }),
      ],
    });
    at("accounts");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    await waitFor(() => expect(rows[1]?.textContent).toContain("not signed in"));
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(rows[2]?.textContent).toContain("signed in");
    expect(rows[2]?.textContent).not.toContain("Fictional operator");
  });

  it("Accounts: the GitHub row shows what is left, the poll cost and the reset", async () => {
    load({ "/api/limits/github": GITHUB_RATE });
    at("accounts");
    expect(await screen.findByText(GITHUB_RATE_LINE)).toBeTruthy();
    expect(document.getElementById("page-setup")?.textContent).not.toContain("slowed");
  });

  it("Accounts: the GitHub row is — before any reading", async () => {
    load({ "/api/limits/github": { queries: {}, pollCost: null } });
    at("accounts");
    expect(await screen.findByText("GitHub API · —")).toBeTruthy();
  });

  it("Accounts: shows the collector's slowed note beside the GitHub row", async () => {
    const note = `${GITHUB_SLOWED_PREFIX} rate limit low (400 left, resets 15:00)`;
    load({
      "/api/limits/github": GITHUB_RATE,
      "/api/health": [health({ collector: "github:shop-app", error: note })],
    });
    at("accounts");
    expect((await screen.findByText(note)).getAttribute("role")).toBe("status");
  });

  it("Accounts: a failed usage collector does not prevent a CLI Signed in reading", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/health": [health({ collector: "usage:claude-main", ok: false, error: "401" })],
      "/api/accounts/status": [
        {
          accountId: "claude-main",
          status: "logged-in",
          checkedAt: NOW,
          plan: "team",
          identity: "Fictional operator",
        },
      ],
    });
    at("accounts");
    const table = await screen.findByRole("table");
    await waitFor(() =>
      expect(within(table).getAllByRole("row")[1]?.textContent).toContain("signed in"),
    );
  });

  it("Accounts: thresholds, rounded quota and the full nine-column table", async () => {
    load();
    at("accounts");
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Name",
      "Vendor",
      "Login",
      "Models",
      "5h",
      "7d",
      "Resets",
      "Alert / stop",
      "Actions",
    ]);
    const rows = within(table).getAllByRole("row");
    const claude = rows[1] as HTMLElement;
    expect(claude.textContent).toContain("claude-main");
    expect(claude.textContent).toContain("85%");
    expect(claude.textContent).toContain("95%");
    expect(claude.textContent).toContain("38%");
    expect(claude.textContent).toContain("80%");
    expect(claude.querySelector(".meter.hi")).toBeNull();
    expect(claude.querySelector(".meter.full")).toBeNull();
    const codex = rows[2] as HTMLElement;
    expect(codex.textContent).toContain("100%");
    expect(codex.querySelectorAll(".meter.full")).toHaveLength(2);
    expect(
      screen.getByText(
        "one profile per login · Mission Control never displays or stores credentials",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Auto-approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(CFG.accounts.length);
  });

  const FREE: TestLockState = { holder: null, waiting: [] };
  const NO_HITS: GuardHitsView = {
    hits: [],
    counts: Object.fromEntries(
      Object.keys(GUARD_RULES).map((r) => [r, 0]),
    ) as GuardHitsView["counts"],
  };

  it("Roles: the call signs", async () => {
    load({ "/api/test-lock": FREE, "/api/guard/hits?days=7": NO_HITS });
    at("roles");
    const roles = within(await screen.findByRole("region", { name: "Roles" })).getByRole("table");
    expect(within(roles).getAllByRole("row")).toHaveLength(ROLES.length + 1);
    expect(roles.textContent).toContain("Flight Dynamics Officer");
    expect(roles.textContent).toContain("backend developer, test-first in its area");
  });

  it("Roles: the long Here, Rule and Runs freely cells wrap and carry the full text as a title", async () => {
    load({ "/api/test-lock": FREE, "/api/guard/hits?days=7": NO_HITS });
    at("roles");
    const roles = within(await screen.findByRole("region", { name: "Roles" })).getByRole("table");
    const here = within(roles).getByText(ROLES[0]?.here as string);
    expect(here.classList.contains("wrap")).toBe(true);
    expect(here.getAttribute("title")).toBe(ROLES[0]?.here);
    const guard = within(screen.getByRole("region", { name: "Guard" })).getByText(
      GUARD_RULES[Object.keys(GUARD_RULES)[0] as GuardRule],
    );
    expect(guard.classList.contains("wrap")).toBe(true);
    expect(guard.getAttribute("title")).toBe(guard.textContent);
    const lock = await screen.findByRole("region", { name: "Test lock" });
    const free = within(lock).getAllByText(FREE_SUITE_HINT)[0] as HTMLElement;
    expect(free.classList.contains("wrap")).toBe(true);
    expect(free.getAttribute("title")).toBe(FREE_SUITE_HINT);
  });

  it("Roles: the guard lists each rule with its hits this week, and the note", async () => {
    load({
      "/api/test-lock": FREE,
      "/api/guard/hits?days=7": {
        ...NO_HITS,
        counts: { ...NO_HITS.counts, "git-write": 3, "full-suite": 2 },
      },
    });
    at("roles");
    const guard = await screen.findByRole("region", { name: "Guard" });
    await waitFor(() => expect(guard.textContent).toContain("3"));
    const rows = within(guard).getAllByRole("row");
    expect(rows).toHaveLength(Object.keys(GUARD_RULES).length + 1);
    expect(rows[0]?.textContent).toBe("RuleHits");
    const byRule = (text: string) =>
      rows.find((r) => r.textContent?.startsWith(text)) as HTMLElement;
    expect(byRule(GUARD_RULES["git-write"]).textContent).toBe(`${GUARD_RULES["git-write"]}3`);
    expect(byRule(GUARD_RULES["full-suite"]).textContent).toBe(`${GUARD_RULES["full-suite"]}2`);
    expect(byRule(GUARD_RULES.network).textContent).toBe(`${GUARD_RULES.network}0`);
    expect(within(guard).getByText(GUARD_NOTE)).toBeTruthy();
  });

  it("Roles: the test lock lists each repo profile's full-suite commands and what runs freely", async () => {
    load({ "/api/test-lock": FREE, "/api/guard/hits?days=7": NO_HITS });
    at("roles");
    const lock = await screen.findByRole("region", { name: "Test lock" });
    await within(lock).findByText(LOCK_FREE_TEXT);
    const rows = within(lock).getAllByRole("row");
    expect(rows[0]?.textContent).toBe("Repo profileFull suite (takes the lock)Runs freely");
    const shopApp = rows.find((r) => r.textContent?.startsWith("shop-app")) as HTMLElement;
    expect(shopApp.textContent).toBe(`shop-apppnpm test, pnpm -s test${FREE_SUITE_HINT}`);
    const other = rows.find((r) => r.textContent?.startsWith("site-builder")) as HTMLElement;
    expect(other.textContent).toBe(`site-builder—${FREE_SUITE_HINT}`);
  });

  it("Roles: the test lock names the holder and the seats waiting", async () => {
    load({
      "/api/test-lock": {
        holder: { runId: "r-1", seatId: "guido-2", command: "pnpm test", since: NOW - 83_000 },
        waiting: [
          { runId: "r-2", seatId: "guido-3", command: "pnpm -s test", since: NOW - 12_000 },
          { runId: "r-3", seatId: "network-1", command: "pnpm -s test", since: NOW - 4_000 },
        ],
      } satisfies TestLockState,
      "/api/guard/hits?days=7": NO_HITS,
    });
    at("roles");
    const lock = await screen.findByRole("region", { name: "Test lock" });
    await within(lock).findByText("GUIDO-2 holds it: pnpm test · 1:23");
    expect(within(lock).getByText("GUIDO-3 waiting · 0:12")).toBeTruthy();
    expect(within(lock).getByText("NETWORK-1 waiting · 0:04")).toBeTruthy();
    expect(lock.textContent).not.toContain(LOCK_FREE_TEXT);
  });

  it("Roles: explains the full-suite lock policy and single-file bypass", async () => {
    load();
    at("roles");
    const lock = await screen.findByRole("region", { name: "Test lock" });
    expect(lock.textContent).toContain(
      "One full suite at a time across the machine; others wait in line, oldest first.",
    );
    expect(lock.textContent).toContain(
      `A full-suite command an agent types is held in the same line and runs when it reaches the front; after about ${LOCK_WAIT_MS / MIN} minutes it is told to retry later or run a single file. Max at once: 1.`,
    );
    expect(lock.textContent).toContain("Single-file runs go straight through.");
  });

  it("Sources: GitHub connected, a note is not a failure, last poll per repo", async () => {
    load();
    at("sources");
    const gh = await screen.findByRole("region", { name: "GitHub" });
    await waitFor(() => expect(gh.textContent).toContain("Connected"));
    expect(gh.textContent).toContain("octo-org/shop-app · project 2");
    expect(gh.textContent).toContain("5 min ago");
    expect(gh.textContent).toContain("octo-org/site-builder · project 3");
    expect(gh.textContent).toContain("never");
    expect(gh.textContent).not.toContain("Failing");
    expect(gh.textContent).toContain(
      "Writes (comments, labels, board moves, Priority) go through approvals; nothing posts on its own.",
    );
    const teams = screen.getByRole("region", { name: "Microsoft Teams" });
    expect(teams.textContent).toContain("P5");
    expect(teams.textContent).toContain("Work only · phase 5.");
    const agents = screen.getByRole("region", { name: "Agents" });
    expect(agents.textContent).toContain(
      "Claude (Agent SDK): messages, tool calls, usage per call, run totals with cost and timing, rate-limit events, context breakdown, subagent progress, task-list updates, hooks.",
    );
    expect(agents.textContent).toContain(
      "This Mac: CPU, memory, disk and per-process memory, read by mc-server.",
    );
    expect(screen.getByTestId("config-yaml")).toBeTruthy();
  });

  it("Sources: explains GitHub collection, future Teams ingestion and Codex capabilities", async () => {
    load();
    at("sources");
    const gh = await screen.findByRole("region", { name: "GitHub" });
    expect(gh.textContent).toContain("PRs, checks and reviews per ticket.");
    expect(gh.textContent).toContain(
      "Notifications: mentions of you or your team, review requests, and comments on your issues, PRs and threads feed Needs you, for the repos in your config.",
    );
    const teams = screen.getByRole("region", { name: "Microsoft Teams" });
    expect(teams.textContent).toContain("Work only · phase 5.");
    expect(teams.textContent).toContain(
      'Watches the chats and channels you pick for: your name or @mentions, your ticket and PR numbers, and words like "bug", "broken" or "urgent" near your areas.',
    );
    expect(teams.textContent).toContain(
      "Matches become Needs you items or a FLIGHT digest, with a link to the message. FLIGHT can draft a GitHub issue from one for you to approve.",
    );
    expect(teams.textContent).toContain("Mission Control never posts to Teams.");
    const agents = screen.getByRole("region", { name: "Agents" });
    expect(agents.textContent).toContain(
      "Codex (app-server): items, token usage with the context window, live rate limits, plan updates, per-turn diffs.",
    );
  });

  it("Sources: Not polled yet when no GitHub collector has reported", async () => {
    load({ "/api/health": [health({ collector: "machine", ok: true })] });
    at("sources");
    const gh = await screen.findByRole("region", { name: "GitHub" });
    await waitFor(() => expect(gh.textContent).toContain("Not polled yet"));
    expect(gh.textContent).not.toContain("Connected");
  });

  it("Sources: Failing with the error when a collector is not ok", async () => {
    load({
      "/api/health": [
        ...HEALTH,
        health({ collector: "flow:site-builder", ok: false, error: "rate limited" }),
      ],
    });
    at("sources");
    const gh = await screen.findByRole("region", { name: "GitHub" });
    await waitFor(() => expect(gh.textContent).toContain("Failing"));
    expect(gh.textContent).toContain("flow:site-builder: rate limited");
  });

  it("Sources: shows the error, and still the glossary, when the config cannot be loaded", async () => {
    load({ "/api/config": () => ({ status: 500, body: { error: "config unreadable" } }) });
    at("sources");
    expect(await screen.findByText(/Could not load the config/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Glossary and data model" })).toBeTruthy();
  });

  it("Sources: scrolls to the glossary again once the config has arrived", async () => {
    load();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/setup/sources#glossary");
    render(<Setup tab="sources" />);
    await screen.findByTestId("config-yaml");
    expect(scroll.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Access: the Mac only and an honest browser delivery description", async () => {
    load();
    at("access");
    const dev = await screen.findByRole("table");
    const rows = within(dev).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain("runs Mission Control and the agents");
    expect(rows[1]?.textContent).toContain("this machine");
    expect(screen.getByText("Other devices arrive with Tailscale (phase 4).")).toBeTruthy();
    expect(screen.getByText("in this open browser on this machine")).toBeTruthy();
    expect(
      screen.getByText("Keep this browser open for delivery. No closed-tab remote push delivery."),
    ).toBeTruthy();
  });

  it("Access: previews person, decision and stalled-run notifications with sample actions", async () => {
    load();
    at("access");
    const previews = await screen.findByRole("region", { name: "What a notification looks like" });
    expect(within(previews).getByText("samples")).toBeTruthy();
    expect(within(previews).getAllByText("Mission Control")).toHaveLength(3);
    expect(
      within(previews).getByText(
        "Example colleague asked you in Product rollout: per-client lanes before the Example customer pilot?",
      ),
    ).toBeTruthy();
    expect(
      within(previews).getByText(
        "Decision for you: lanes per customer, or one global list? (GUIDO-3, NW #2358)",
      ),
    ).toBeTruthy();
    expect(
      within(previews).getByText(
        "GUIDO-2's full-suite run has printed nothing for 11 min and holds the test lock.",
      ),
    ).toBeTruthy();
    expect(
      within(previews)
        .getAllByRole("button")
        .map((b) => b.textContent?.trim()),
    ).toEqual([
      "Read the brief",
      "Open in Teams",
      "Later",
      "Read the brief",
      "Discuss",
      "Later",
      "Stop the run",
      "Open",
    ]);
  });

  describe("Sessions: seats", () => {
    it.each(["s1", "s2", "unknown"])(
      "?add=%s opens only the matching session's form",
      async (id) => {
        const crew = CREW_CONFIG.crew;
        const first = crew?.sessions[0];
        if (!crew || !first) throw new Error("no crew session");
        load({
          "/api/config": {
            ...SESSIONS_CFG,
            crew: { ...crew, sessions: [first, { ...first, id: "s2", seats: [] }] },
          },
          "/api/crew/changes": CHANGES,
        });
        window.history.replaceState(null, "", `/setup/sessions?add=${id}`);
        render(<Setup tab="sessions" />);
        await screen.findByRole("region", { name: "s/s2" });
        await settled(fetchFn, "/api/crew/changes");
        if (id === "unknown") {
          expect(screen.queryByRole("form")).toBeNull();
        } else {
          const form = await screen.findByRole("form", { name: `Add agent to s/${id}` });
          expect(screen.getAllByRole("form")).toEqual([form]);
          fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
          expect(screen.queryByRole("form")).toBeNull();
        }
      },
    );

    it("replaces the add-agent URL, stays closed after Cancel, and does not reopen on reload", async () => {
      load({ "/api/config": SESSIONS_CFG, "/api/crew/changes": CHANGES });
      window.history.replaceState(null, "", "/setup/sessions?add=s1");
      const historyLength = window.history.length;
      const page = render(<Setup tab="sessions" />);
      const form = await screen.findByRole("form", { name: "Add agent to s/s1" });
      expect(window.location.search).toBe("");
      expect(window.location.pathname).toBe("/setup/sessions");
      expect(window.history.length).toBe(historyLength);
      // The same form element: clearing the URL did not remount Sessions and close it.
      expect(screen.getByRole("form", { name: "Add agent to s/s1" })).toBe(form);
      fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("form")).toBeNull();
      page.unmount();
      render(<Setup tab="sessions" />);
      await screen.findByRole("region", { name: "s/s1" });
      expect(screen.queryByRole("form")).toBeNull();
    });

    it("renders safely without a form while crew changes are unresolved", async () => {
      load({ "/api/config": SESSIONS_CFG });
      const answer = fetchFn.getMockImplementation();
      if (!answer) throw new Error("no fetch implementation");
      fetchFn.mockImplementation((input, init) =>
        input === "/api/crew/changes" ? new Promise<Response>(() => {}) : answer(input, init),
      );
      window.history.replaceState(null, "", "/setup/sessions?add=s1");
      render(<Setup tab="sessions" />);
      await settled(fetchFn, "/api/config");
      expect(fetchFn).toHaveBeenCalledWith("/api/crew/changes", expect.anything());
      expect(screen.getByRole("region", { name: "s/s1" })).toBeTruthy();
      expect(screen.queryByRole("form")).toBeNull();
      expect(window.location.search).toBe("?add=s1");
    });

    it("keeps the requested session visible outside the session filter after Cancel", async () => {
      load({ "/api/config": SESSIONS_CFG, "/api/crew/changes": CHANGES });
      setSession("site-builder");
      const page = at("sessions");
      await settled(fetchFn, "/api/config");
      expect(screen.getByText(SESSIONS_NOTE)).toBeTruthy();
      expect(screen.queryByRole("region", { name: "s/s1" })).toBeNull();
      page.unmount();
      window.history.replaceState(null, "", "/setup/sessions?add=s1");
      render(<Setup tab="sessions" />);
      const form = await screen.findByRole("form", { name: "Add agent to s/s1" });
      fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("form")).toBeNull();
      expect(screen.getByRole("region", { name: "s/s1" })).toBeTruthy();
    });

    const BACKUP = "config.yaml.bak-x";
    const SAVED = { backup: BACKUP, changes: { ...CHANGES, applied: [] } };
    const post = (path: string) => {
      const call = fetchFn.mock.calls.find(([p, i]) => p === path && i?.method === "POST");
      return call ? JSON.parse(String(call[1]?.body)) : undefined;
    };
    const posts = (path: string) =>
      fetchFn.mock.calls.filter(([p, i]) => p === path && i?.method === "POST").length;
    const toastText = () => document.getElementById("toast")?.textContent;

    async function seats(over: Record<string, unknown> = {}) {
      load({
        "/api/config": SESSIONS_CFG,
        "/api/crew/changes": CHANGES,
        "/api/crew/sessions": sessionsOf([{ name: "apps", owners: ["guido-1"] }]),
        "POST /api/crew/sessions/s1/seats": () => ({ status: 200, body: SAVED }),
        ...over,
      });
      window.history.replaceState(null, "", "/setup/sessions");
      render(
        <>
          <Setup tab="sessions" />
          <Toast />
        </>,
      );
      const p = await screen.findByRole("region", { name: "s/s1" });
      await within(p).findByRole("table", { name: "Seats of s/s1 in config.yaml" });
      return p;
    }
    const open = async (p: HTMLElement) => {
      fireEvent.click(within(p).getByRole("button", { name: "Add agent" }));
      return screen.findByRole("form", { name: "Add agent to s/s1" });
    };

    it("Sessions: the seats table", async () => {
      const retiring = {
        id: "inco-9",
        role: "INCO",
        mode: "writer",
        accountId: "claude-main",
        model: "sonnet",
        area: ["docs/**"],
        retiring: true,
      };
      const session = SESSIONS_CFG.crew?.sessions[0];
      if (!SESSIONS_CFG.crew || !session) throw new Error("no session");
      const p = await seats({
        "/api/crew?shape=summary": {
          rows: [
            seatRow({ hudState: "running" }),
            seatRow({ id: "retro-1", role: "RETRO", mode: "read-only", hudState: "idle" }),
          ],
          firstRunToday: null,
        },
        "/api/config": {
          ...SESSIONS_CFG,
          crew: {
            ...SESSIONS_CFG.crew,
            sessions: [{ ...session, seats: [...session.seats, retiring] }],
          },
        },
        "/api/crew/changes": {
          ...CHANGES,
          pending: [
            {
              sessionId: "s1",
              seatId: "guido-1",
              change: "edit",
              reason: "changed; applies when it is free",
            },
            {
              sessionId: "s1",
              seatId: "inco-9",
              change: "remove",
              reason: "removed; finishing its run",
            },
          ],
        },
      });
      const t = within(p).getByRole("table", { name: "Seats of s/s1 in config.yaml" });
      const rows = within(t).getAllByRole("row");
      expect(rows).toHaveLength(4);
      const cells = (r: HTMLElement) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent);
      expect(cells(rows[1] as HTMLElement).slice(0, 5)).toEqual([
        "guido-1",
        "GUIDO",
        "sonnet",
        "apps/**",
        "changed; applies when it is free",
      ]);
      expect(cells(rows[2] as HTMLElement)[3]).toBe("read-only");
      await waitFor(() => expect(cells(rows[2] as HTMLElement)[4]).toBe("Idle"));
      expect(cells(rows[3] as HTMLElement)[4]).toBe("removed; finishing its run");
      expect(within(rows[3] as HTMLElement).queryByRole("button")).toBeNull();
    });

    it("Sessions: a seat with no crew row and no pending change has a dash for its status", async () => {
      const p = await seats();
      const t = within(p).getByRole("table", { name: "Seats of s/s1 in config.yaml" });
      const rows = within(t).getAllByRole("row");
      expect(within(rows[1] as HTMLElement).getAllByRole("cell")[4]?.textContent).toBe("—");
    });

    it.each([
      [
        "paused",
        seatRow({
          crewPause: { seats: ["guido-1"], reason: "Save tokens", at: NOW, by: "operator" },
        }),
        "Paused",
        "Save tokens",
      ],
      [
        "parked",
        seatRow({ id: "retro-1", hudState: "parked", note: "Awaiting operator" }),
        "Parked",
        "Awaiting operator",
      ],
    ] as const)(
      "Sessions: shows a %s seat's short state and reason tooltip",
      async (_state, seat, label, reason) => {
        const p = await seats({
          "/api/crew?shape=summary": { rows: [seat], firstRunToday: null },
        });
        const t = within(p).getByRole("table", { name: "Seats of s/s1 in config.yaml" });
        const row = within(t).getByText(seat.id).closest("tr") as HTMLElement;
        const pill = within(row).getByText(label);
        expect(pill.parentElement?.getAttribute("title")).toBe(reason);
      },
    );

    it("Sessions: the Reload button's wrapper spans the grid row", async () => {
      await seats();
      const wrap = screen.getByRole("button", { name: "Reload config.yaml" }).parentElement;
      expect(wrap?.className).toBe("wide");
    });

    it("Add agent: defaults, tiles, body", async () => {
      const p = await seats();
      const form = await open(p);
      fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "INCO" } });
      expect(within(form).getByLabelText("Call sign")).toHaveProperty("value", "inco-1");
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "sonnet");
      const tile = within(p).getByRole("button", { name: /apps\// });
      expect(tile.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(tile);
      expect(within(form).getByLabelText(/^Area/)).toHaveProperty("value", "apps/**");
      expect(form.textContent).toContain(SAVE_NOTE);
      fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
      await waitFor(() => expect(toastText()).toBe(addedText("INCO-1", "s1", BACKUP)));
      expect(post("/api/crew/sessions/s1/seats")).toEqual({
        base: [GUIDO_SEAT, RETRO_SEAT],
        seats: [
          GUIDO_SEAT,
          RETRO_SEAT,
          {
            id: "inco-1",
            role: "INCO",
            accountId: "claude-main",
            model: "sonnet",
            area: ["apps/**"],
          },
        ],
      });
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    });

    it("Add agent: a read-only role", async () => {
      const p = await seats();
      const form = await open(p);
      fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "RETRO" } });
      expect(within(form).getByLabelText(/^Area/)).toHaveProperty("disabled", true);
      expect(within(p).queryByRole("button", { name: /apps\// })).toBeNull();
      fireEvent.click(within(form).getByLabelText(SCRATCH_LABEL));
      fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
      await waitFor(() => expect(posts("/api/crew/sessions/s1/seats")).toBe(1));
      expect(post("/api/crew/sessions/s1/seats").seats[2]).toEqual({
        id: "retro-2",
        role: "RETRO",
        accountId: "claude-main",
        model: "opus",
        area: [],
        mode: "scratch",
      });
    });

    it("a bad call sign disables Save", async () => {
      const p = await seats();
      const form = await open(p);
      fireEvent.change(within(form).getByLabelText("Call sign"), { target: { value: "Bad Name" } });
      expect(form.textContent).toContain("lower-case letters, digits and -");
      expect(within(form).getByRole("button", { name: "Add agent" })).toHaveProperty(
        "disabled",
        true,
      );
    });

    it("Edit", async () => {
      const p = await seats();
      const row = within(p).getByRole("row", { name: /guido-1/ });
      fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
      const form = await screen.findByRole("form", { name: "Edit guido-1" });
      expect(within(form).getByLabelText("Role")).toHaveProperty("value", "GUIDO");
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "sonnet");
      expect(within(form).getByLabelText("Effort")).toHaveProperty("value", "");
      expect(within(form).getByLabelText(/^Area/)).toHaveProperty("value", "apps/**");
      fireEvent.change(within(form).getByLabelText("Model"), { target: { value: "opus" } });
      fireEvent.change(within(form).getByLabelText("Effort"), { target: { value: "high" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save guido-1" }));
      await waitFor(() => expect(toastText()).toBe(savedText("GUIDO-1", BACKUP)));
      expect(post("/api/crew/sessions/s1/seats").seats).toEqual([
        { ...GUIDO_SEAT, model: "opus", effort: "high" },
        RETRO_SEAT,
      ]);
    });

    it("Remove needs a confirm", async () => {
      const p = await seats();
      const row = within(p).getByRole("row", { name: /retro-1/ });
      fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
      expect(posts("/api/crew/sessions/s1/seats")).toBe(0);
      fireEvent.click(within(row).getByRole("button", { name: "Confirm remove retro-1" }));
      await waitFor(() => expect(toastText()).toBe(removedText("RETRO-1", "s1", BACKUP)));
      expect(post("/api/crew/sessions/s1/seats")).toEqual({
        base: [GUIDO_SEAT, RETRO_SEAT],
        seats: [GUIDO_SEAT],
      });
    });

    it("A refusal keeps the form", async () => {
      const error =
        "crew.sessions[0].seats[2].area: areas overlap: guido-1 and inco-1; one folder, one owner";
      const p = await seats({
        "POST /api/crew/sessions/s1/seats": () => ({ status: 400, body: { error } }),
      });
      const form = await open(p);
      fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
      const alert = await within(form).findByRole("alert");
      expect(alert.textContent).toBe(refusedText(error));
      expect(screen.getByRole("form", { name: "Add agent to s/s1" })).toBeTruthy();
    });

    it("A conflict refetches", async () => {
      const p = await seats({
        "POST /api/crew/sessions/s1/seats": () => ({
          status: 409,
          body: { error: "the seats changed since this page loaded them; reload and try again" },
        }),
      });
      const form = await open(p);
      const fetched = (path: string) => fetchFn.mock.calls.filter(([u]) => u === path).length;
      const before = fetched("/api/crew/changes");
      const configBefore = fetched("/api/config");
      fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
      await waitFor(() => expect(fetched("/api/crew/changes")).toBe(before + 1));
      await waitFor(() => expect(fetched("/api/config")).toBe(configBefore + 1));
    });

    it("Edit: a scratch seat opens with the scratch box checked", async () => {
      const p = await seats({
        "/api/crew/changes": {
          ...CHANGES,
          sessions: [{ id: "s1", seats: [GUIDO_SEAT, { ...RETRO_SEAT, mode: "scratch" }] }],
        },
      });
      const row = within(p).getByRole("row", { name: /retro-1/ });
      fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
      const form = await screen.findByRole("form", { name: "Edit retro-1" });
      expect(within(form).getByLabelText(SCRATCH_LABEL)).toHaveProperty("checked", true);
    });

    it("a role change to a read-only role clears Area and resets Model; empty Model disables Save", async () => {
      const p = await seats();
      const form = await open(p);
      fireEvent.click(within(p).getByRole("button", { name: /apps\// }));
      expect(within(form).getByLabelText(/^Area/)).toHaveProperty("value", "apps/**");
      fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "RETRO" } });
      expect(within(form).getByLabelText(/^Area/)).toHaveProperty("value", "");
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "opus");
      fireEvent.change(within(form).getByLabelText("Model"), { target: { value: " " } });
      expect(within(form).getByRole("button", { name: "Add agent" })).toHaveProperty(
        "disabled",
        true,
      );
    });

    it("adds Codex seats and resets the model only when the account provider changes", async () => {
      const p = await seats();
      const form = await open(p);
      const account = within(form).getByLabelText("Account");
      const model = within(form).getByLabelText("Model");
      fireEvent.change(account, { target: { value: "codex-main" } });
      expect(account).toHaveProperty("value", "codex-main");
      expect(model).toHaveProperty("value", "gpt-5.6-sol");
      fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "RETRO" } });
      expect(model).toHaveProperty("value", "gpt-5.6-sol");
      fireEvent.submit(form);
      await waitFor(() => expect(posts("/api/crew/sessions/s1/seats")).toBe(1));
      expect(post("/api/crew/sessions/s1/seats").seats[2]).toMatchObject({
        accountId: "codex-main",
        model: "gpt-5.6-sol",
        role: "RETRO",
        area: [],
      });
    });

    it("opens a persisted Codex seat with its model and switches back to the role default", async () => {
      const codex = { ...GUIDO_SEAT, accountId: "codex-main", model: "gpt-5.6-sol" };
      const p = await seats({
        "/api/crew/changes": { ...CHANGES, sessions: [{ id: "s1", seats: [codex] }] },
      });
      fireEvent.click(within(p).getByRole("button", { name: "Edit" }));
      const form = screen.getByRole("form", { name: "Edit guido-1" });
      expect(within(form).getByLabelText("Account")).toHaveProperty("value", "codex-main");
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "gpt-5.6-sol");
      fireEvent.change(within(form).getByLabelText("Account"), {
        target: { value: "claude-main" },
      });
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "sonnet");
      fireEvent.change(within(form).getByLabelText("Account"), {
        target: { value: "codex-main" },
      });
      fireEvent.change(within(form).getByLabelText("Effort"), { target: { value: "high" } });
      fireEvent.submit(form);
      await waitFor(() => expect(posts("/api/crew/sessions/s1/seats")).toBe(1));
      const saved = post("/api/crew/sessions/s1/seats").seats[0];
      expect(saved).toEqual({ ...codex, effort: "high" });
      cleanup();
      const reloaded = await seats({
        "/api/crew/changes": { ...CHANGES, sessions: [{ id: "s1", seats: [saved] }] },
      });
      fireEvent.click(within(reloaded).getByRole("button", { name: "Edit" }));
      const reopened = screen.getByRole("form", { name: "Edit guido-1" });
      expect(within(reopened).getByLabelText("Account")).toHaveProperty("value", "codex-main");
      expect(within(reopened).getByLabelText("Model")).toHaveProperty("value", "gpt-5.6-sol");
      expect(within(reopened).getByLabelText("Effort")).toHaveProperty("value", "high");
    });

    it("switching to Claude never keeps a role's Codex default model", async () => {
      const crew = SESSIONS_CFG.crew;
      if (!crew?.roles) throw new Error("missing crew roles");
      const codex = { ...GUIDO_SEAT, accountId: "codex-main", model: "gpt-5.6-sol" };
      const p = await seats({
        "/api/config": {
          ...SESSIONS_CFG,
          crew: {
            ...crew,
            roles: crew.roles.map((r) => (r.name === "GUIDO" ? { ...r, model: "gpt-5.6-sol" } : r)),
          },
        },
        "/api/crew/changes": { ...CHANGES, sessions: [{ id: "s1", seats: [codex] }] },
      });
      fireEvent.click(within(p).getByRole("button", { name: "Edit" }));
      const form = screen.getByRole("form", { name: "Edit guido-1" });
      fireEvent.change(within(form).getByLabelText("Account"), {
        target: { value: "claude-main" },
      });
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "sonnet");
    });

    it.each(["unknown", "not-logged-in"])(
      "shows the external CLI hint for %s status",
      async (status) => {
        const p = await seats({
          "/api/accounts/status": [
            {
              accountId: "codex-main",
              provider: "codex",
              binding: "machine",
              identity: null,
              plan: null,
              status,
              checkedAt: NOW,
              detail: null,
            },
          ],
        });
        const form = await open(p);
        fireEvent.change(within(form).getByLabelText("Account"), {
          target: { value: "codex-main" },
        });
        expect(await within(form).findByText(/Sign in with the CLI on this machine/)).toBeTruthy();
      },
    );

    it("defaults to a configured Codex account when no Claude account exists", async () => {
      const p = await seats({
        "/api/config": {
          ...SESSIONS_CFG,
          accounts: SESSIONS_CFG.accounts.filter((a) => a.vendor === "codex"),
        },
      });
      const form = await open(p);
      expect(within(form).getByLabelText("Account")).toHaveProperty("value", "codex-main");
      expect(within(form).getByLabelText("Model")).toHaveProperty("value", "gpt-5.6-sol");
      const account = within(form).getByLabelText("Account");
      account.focus();
      expect(document.activeElement).toBe(account);
      fireEvent.submit(form);
      await waitFor(() => expect(posts("/api/crew/sessions/s1/seats")).toBe(1));
      expect(post("/api/crew/sessions/s1/seats").seats[2]).toMatchObject({
        accountId: "codex-main",
        model: "gpt-5.6-sol",
      });
    });

    it("no accounts: the Account select is empty and Save is disabled", async () => {
      const p = await seats({
        "/api/config": {
          ...SESSIONS_CFG,
          accounts: [],
        },
      });
      const form = await open(p);
      expect(within(form).getByLabelText("Account")).toHaveProperty("options.length", 0);
      expect(within(form).getByRole("button", { name: "Add agent" })).toHaveProperty(
        "disabled",
        true,
      );
    });

    it("every save, remove and reload button is disabled while a post is out", async () => {
      const p = await seats();
      const real = fetchFn.getMockImplementation();
      if (!real) throw new Error("no fetch stub");
      let answer = () => {};
      const gate = new Promise<void>((r) => {
        answer = r;
      });
      fetchFn.mockImplementation(async (u, i) => {
        if (i?.method === "POST") await gate;
        return real(u, i);
      });
      const form = await open(p);
      const submit = within(form).getByRole("button", { name: "Add agent" });
      fireEvent.click(submit);
      await waitFor(() => expect(submit).toHaveProperty("disabled", true));
      expect(screen.getByRole("button", { name: "Reload config.yaml" })).toHaveProperty(
        "disabled",
        true,
      );
      for (const b of within(p).getAllByRole("button", { name: "Remove" })) {
        expect(b).toHaveProperty("disabled", true);
      }
      answer();
      await waitFor(() => expect(toastText()).toBe(addedText("GUIDO-2", "s1", BACKUP)));
    });

    it("a refused reload shows the alert", async () => {
      await seats({
        "POST /api/config/reload": () => ({ status: 409, body: { error: "crew is off" } }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Reload config.yaml" }));
      expect((await screen.findByRole("alert")).textContent).toBe(refusedText("crew is off"));
    });

    it("config.yaml state", async () => {
      await seats({
        "/api/crew/changes": { ...CHANGES, error: "bad yaml", restartNeeded: ["loops"] },
        "POST /api/config/reload": () => ({ status: 200, body: { ...CHANGES, applied: [] } }),
      });
      expect((await screen.findByRole("alert")).textContent).toBe(loadErrorText("bad yaml"));
      expect(screen.getByText(restartText(["loops"]))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Reload config.yaml" }));
      await waitFor(() => expect(toastText()).toBe(RELOADED));
      expect(post("/api/config/reload")).toEqual({});
    });

    it("no roles: Add agent is disabled", async () => {
      if (!SESSIONS_CFG.crew) throw new Error("no crew");
      const { roles: _roles, ...noRoles } = SESSIONS_CFG.crew;
      const p = await seats({ "/api/config": { ...SESSIONS_CFG, crew: noRoles } });
      const add = within(p).getByRole("button", { name: "Add agent" });
      expect(add).toHaveProperty("disabled", true);
      expect(add.getAttribute("title")).toBe("this server does not list roles");
    });
  });
});

describe("Setup is read-only (except Repos, Sessions and Accounts)", () => {
  it.each(SETUP_TABS.filter((t) => t !== "repos" && t !== "sessions" && t !== "accounts"))(
    "%s: no enabled field, and no button posts",
    async (tab) => {
      load();
      at(tab);
      // the config-gated tabs show a placeholder until the config answers: scan the real content
      await waitFor(() => {
        const grid = document.querySelector(".sgrid") as HTMLElement;
        expect(grid.textContent).not.toBe("");
        expect(within(grid).queryByText(/^(Loading…|Could not load)/)).toBeNull();
      });
      const body = document.querySelector(".sgrid") as HTMLElement;
      for (const el of body.querySelectorAll("input, select, textarea")) {
        if (tab === "loops" && el.id === "loop-run-picker") continue;
        expect((el as HTMLInputElement).disabled).toBe(true);
      }
      for (const b of body.querySelectorAll("button")) fireEvent.click(b);
      const posts = fetchFn.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
      expect(posts).toEqual([]);
    },
  );
});

function cleanupAndAt(tab: SetupTab) {
  document.body.innerHTML = "";
  at(tab);
}

const PREVIEW: RepoPreview = {
  github: "octo-org/mission-control",
  project: 4,
  defaultBranch: "main",
  projectTitle: "Mission Control",
  items: 37,
  fields: [{ name: "Status", options: ["Todo", "In Progress", "Done"] }],
  statusOptions: ["Todo", "In Progress", "Done"],
  proposedStatusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
  columns: [
    { status: "Todo", column: "Ready" },
    { status: "In Progress", column: "In progress" },
    { status: "Done", column: "Done" },
  ],
  missingColumns: ["Refinement", "Blocked", "In review", "Ready for QA"],
  priority: "labels",
  budget: { boardPerHour: 500, sweepPerHour: 12, flowPerHour: 2, totalPerHour: 514 },
  budgetNow: 1234,
  loops: [],
};

/** A repo card starts as one row; its title button opens it. */
function expandCard(card: HTMLElement): HTMLElement {
  const title = card.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (title?.getAttribute("aria-expanded") === "false") fireEvent.click(title);
  return card;
}

describe("Setup › Repos & seats cards", () => {
  it("a crew repo card opens an Ownership table with area globs and hard-rule files", async () => {
    const value: MapSnapshot = structuredClone(mapSnapshotFixture);
    value.repoId = "shop-app";
    value.tree = [
      { path: "apps/web/a.ts", lines: 10 },
      { path: "CLAUDE.md", lines: 4 },
    ];
    value.rules = { areas: { "area:web": ["apps/web/**"] }, hardRules: ["CLAUDE.md"] };
    value.seats[0] = {
      ...value.seats[0],
      scope: { read: [], modified: [{ file: "CLAUDE.md", add: 2, rem: 0, source: "diff" }] },
    };
    load({
      "/api/config": { ...CREW_CONFIG, loops: CFG.loops },
      "/api/repos/shop-app/map": value,
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    const summary = within(card).getByText("Ownership · areas and hard-rule files");
    // nothing is read until the section is opened
    expect(fetchFn.mock.calls.some(([path]) => String(path).endsWith("/map"))).toBe(false);
    const details = summary.closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await within(card).findByText("Hard-rule files changed · 1 of 1")).toBeTruthy();
    expect(fetchFn.mock.calls.some(([path]) => path === "/api/repos/shop-app/map")).toBe(true);
    expect(card.textContent).toContain("area:web");
    expect(card.textContent).toContain("apps/web/**");
    // an observed repo has no crew checkout to map
    const observed = await screen.findByLabelText("site-builder");
    expect(within(observed).queryByText("Ownership · areas and hard-rule files")).toBeNull();
  });

  it("says why Ownership cannot be shown when the map is unreadable", async () => {
    load({
      "/api/config": { ...CREW_CONFIG, loops: CFG.loops },
      "/api/repos/shop-app/map": () => ({
        status: 503,
        body: { error: "map snapshot unavailable" },
      }),
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    const details = within(card)
      .getByText("Ownership · areas and hard-rule files")
      .closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await within(card).findByText(/Could not read the map for shop-app/)).toBeTruthy();
  });

  it("shows each repo as one collapsed row of name, kind, account and seats, and opens it on demand", async () => {
    load({ "/api/config": { ...CREW_CONFIG, loops: CFG.loops } });
    at("repos");
    const card = await screen.findByLabelText("shop-app");
    const title = card.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(title.getAttribute("aria-expanded")).toBe("false");
    const seatCount = CREW_CONFIG.crew?.sessions[0]?.seats.length ?? 0;
    expect(title.textContent).toContain("shop-app");
    expect(title.textContent).toContain("Crew");
    expect(title.textContent).toContain(`${seatCount} seat`);
    expect(within(card).queryByRole("button", { name: "Save guidance" })).toBeNull();
    const observed = await screen.findByLabelText("site-builder");
    expect(observed.querySelector("button[aria-expanded]")?.textContent).toContain("Observed");
    fireEvent.click(title);
    expect(title.getAttribute("aria-expanded")).toBe("true");
    const seats = within(card).getByRole("region", { name: /^Seats for/ });
    const guidance = within(card).getByText("Work guidance · guidance, not rules");
    // the seats table comes before the guidance form
    expect(seats.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows repo guidance as editable advice without a live board profile", async () => {
    load();
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    expect(card.textContent).toContain("Observed");
    expect(card.textContent).toContain("Work guidance · guidance, not rules");
    expect(within(card).getByRole("button", { name: "Save guidance" })).toBeTruthy();
    expect(within(card).queryByText("Status on GitHub")).toBeNull();
  });

  it("saves account preference and multi-select guidance through the repo setup route", async () => {
    load({ "POST /api/repos/shop-app/setup": () => ({ status: 200, body: { backup: "c.bak" } }) });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    const priority = within(
      within(card).getByRole("group", { name: "Priority" }),
    ).getByPlaceholderText("+ add");
    fireEvent.change(priority, { target: { value: "P1" } });
    fireEvent.keyDown(priority, { key: "Enter" });
    fireEvent.change(within(card).getByLabelText("Default account"), {
      target: { value: "codex-main" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Save guidance" }));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([path]) => path === "/api/repos/shop-app/setup");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        defaultAccountId: "codex-main",
        guidance: { priority: ["P1"], labelMode: "any" },
      });
    });
  });

  it("walks all add steps, then atomically onboards the repo and empty crew session", async () => {
    load({
      "POST /api/repos/preview": PREVIEW,
      "POST /api/repos/checkout-preview": { ok: true },
      "POST /api/repos/onboard": { backup: "c.bak" },
    });
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    fireEvent.change(screen.getByLabelText("GitHub repo"), {
      target: { value: "octo-org/mission" },
    });
    fireEvent.change(screen.getByLabelText("Project number"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Repo id"), { target: { value: "mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Next: checkout" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/work/mission" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next: live checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Run live checks" }));
    await screen.findByText(/Project board verified/);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "crew" } });
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Default account"), {
      target: { value: "codex-main" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    await waitFor(() => {
      expect(fetchFn.mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          "/api/repos/preview",
          "/api/repos/checkout-preview",
          "/api/repos/onboard",
        ]),
      );
    });
    const onboard = fetchFn.mock.calls.find(([path]) => path === "/api/repos/onboard");
    expect(JSON.parse(String(onboard?.[1]?.body))).toMatchObject({
      repo: { id: "mission", github: "octo-org/mission", project: 4 },
      repoId: "mission",
      checkout: { source: "/work/mission", branch: "main" },
      session: { id: "mission", checkoutStrategy: "shared" },
    });
  });

  it("shows a failed live check and makes no configuration write", async () => {
    load({
      "POST /api/repos/preview": PREVIEW,
      "POST /api/repos/checkout-preview": () => ({
        status: 400,
        body: { error: "origin does not match" },
      }),
    });
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    fireEvent.change(screen.getByLabelText("GitHub repo"), {
      target: { value: "octo-org/mission" },
    });
    fireEvent.change(screen.getByLabelText("Project number"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Repo id"), { target: { value: "mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Next: checkout" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next: live checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Run live checks" }));
    expect((await screen.findByRole("alert")).textContent).toContain("origin does not match");
    expect(fetchFn.mock.calls.some(([path]) => path === "/api/repos/onboard")).toBe(false);
  });

  it("ignores a stale repo preview after checkout details change", async () => {
    load();
    const answer = fetchFn.getMockImplementation() as (...args: unknown[]) => Promise<Response>;
    let resolve: ((response: Response) => void) | undefined;
    fetchFn.mockImplementation(async (...args) => {
      if (args[0] !== "/api/repos/preview") return answer(...args);
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    fireEvent.change(screen.getByLabelText("GitHub repo"), {
      target: { value: "octo-org/mission" },
    });
    fireEvent.change(screen.getByLabelText("Project number"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Repo id"), { target: { value: "mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Next: checkout" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/work/mission" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next: live checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Run live checks" }));
    await waitFor(() => expect(resolve).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/work/new" },
    });
    await act(async () => resolve?.(new Response(JSON.stringify(PREVIEW), { status: 200 })));
    expect(screen.queryByText(/Project board verified/)).toBeNull();
    expect(fetchFn.mock.calls.some(([path]) => path === "/api/repos/checkout-preview")).toBe(false);
  });

  it("ignores a stale checkout response after its folder changes", async () => {
    load({ "POST /api/repos/preview": PREVIEW });
    const answer = fetchFn.getMockImplementation() as (...args: unknown[]) => Promise<Response>;
    let resolve: ((response: Response) => void) | undefined;
    fetchFn.mockImplementation(async (...args) => {
      if (args[0] !== "/api/repos/checkout-preview") return answer(...args);
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    fireEvent.change(screen.getByLabelText("GitHub repo"), {
      target: { value: "octo-org/mission" },
    });
    fireEvent.change(screen.getByLabelText("Project number"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Repo id"), { target: { value: "mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Next: checkout" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/work/mission" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next: live checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Run live checks" }));
    await waitFor(() => expect(resolve).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/work/new" },
    });
    await act(async () => resolve?.(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    expect(screen.queryByText(/Project board verified/)).toBeNull();
  });

  it("keeps the stepper open when atomic onboarding fails without issuing partial writes", async () => {
    load({
      "POST /api/repos/preview": PREVIEW,
      "POST /api/repos/checkout-preview": { ok: true },
      "POST /api/repos/onboard": () => ({
        status: 500,
        body: { error: "could not write config.yaml" },
      }),
    });
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    fireEvent.change(screen.getByLabelText("GitHub repo"), {
      target: { value: "octo-org/mission" },
    });
    fireEvent.change(screen.getByLabelText("Project number"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Repo id"), { target: { value: "mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Next: checkout" }));
    fireEvent.change(within(screen.getByLabelText("Add repo")).getByLabelText("Checkout folder"), {
      target: { value: "/work/mission" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next: live checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Run live checks" }));
    await screen.findByText(/Project board verified/);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "crew" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not write config.yaml");
    expect(fetchFn.mock.calls.filter(([path]) => path === "/api/repos/onboard")).toHaveLength(1);
    expect(fetchFn.mock.calls.some(([path]) => path === "/api/repos")).toBe(false);
    expect(fetchFn.mock.calls.some(([path]) => path === "/api/crew/sessions")).toBe(false);
  });

  it("converts an observed repo through the validated crew-session path", async () => {
    load({
      "POST /api/repos/preview": PREVIEW,
      "POST /api/repos/checkout-preview": { ok: true },
      "POST /api/repos/onboard": { backup: "c.bak" },
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    fireEvent.click(within(card).getByRole("button", { name: "Convert to crew repo" }));
    fireEvent.click(screen.getByRole("button", { name: "Next: checkout" }));
    fireEvent.change(
      within(screen.getByLabelText("Convert shop-app to crew repo")).getByLabelText(
        "Checkout folder",
      ),
      { target: { value: "/work/shop" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next: live checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Run live checks" }));
    await screen.findByText(/Project board verified/);
    fireEvent.click(
      within(screen.getByLabelText("Convert shop-app to crew repo")).getByRole("button", {
        name: "Convert to crew repo",
      }),
    );
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([path]) => path === "/api/repos/onboard")).toBe(true),
    );
    expect(fetchFn.mock.calls.some(([path]) => path === "/api/repos")).toBe(false);
  });
});

describe("Setup toolbar: Update", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const version = (over: Partial<VersionInfo> = {}): VersionInfo => ({
    sha: SHA,
    behind: 3,
    checkedAt: NOW,
    canUpdate: true,
    reason: null,
    ...over,
  });
  const toolbar = () => document.querySelector("#page-setup .toolbar") as HTMLElement;
  const updateBtn = () => within(toolbar()).getByRole("button", { name: "Update" });

  it("shows the version and how far behind main it is", async () => {
    load({ "/api/version": version() });
    at("sessions");
    expect(
      await within(toolbar()).findByText(
        "Version 0123456 · 3 commits behind main · checked just now",
      ),
    ).toBeTruthy();
    expect((updateBtn() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows when it last checked, in relative time, and nothing before the first check", async () => {
    load({ "/api/version": version({ behind: 0, checkedAt: NOW - 5 * 60_000 }) });
    at("sessions");
    expect(await within(toolbar()).findByText("Version 0123456 · checked 5 min ago")).toBeTruthy();
    cleanup();
    load({ "/api/version": version({ behind: 0, checkedAt: null }) });
    at("sessions");
    expect(await within(toolbar()).findByText("Version 0123456")).toBeTruthy();
  });

  it("says nothing about main when not behind", async () => {
    load({ "/api/version": version({ behind: 0 }) });
    at("sessions");
    expect(await within(toolbar()).findByText("Version 0123456 · checked just now")).toBeTruthy();
  });

  it("says it could not compare when the count is null", async () => {
    load({ "/api/version": version({ behind: null, canUpdate: false, reason: "not on main" }) });
    at("sessions");
    expect(
      await within(toolbar()).findByText(
        "Version 0123456 · could not compare with main · checked just now",
      ),
    ).toBeTruthy();
  });

  it("names one commit in the singular", async () => {
    load({ "/api/version": version({ behind: 1 }) });
    at("sessions");
    expect(
      await within(toolbar()).findByText(
        "Version 0123456 · 1 commit behind main · checked just now",
      ),
    ).toBeTruthy();
  });

  it.each([
    PREVIEW_SERVER,
    "not on main",
    "the checkout has uncommitted changes",
    "GUIDO-1 is mid-turn",
  ])("disables Update with the reason as its title: %s", async (reason) => {
    load({ "/api/version": version({ canUpdate: false, reason }) });
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    const b = updateBtn() as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(reason);
  });

  it("disables Update, with Up to date with main. as its title, when there is nothing to pull", async () => {
    load({
      "/api/version": version({ behind: 0, canUpdate: false, reason: UP_TO_DATE_MAIN }),
    });
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    const b = updateBtn() as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(UP_TO_DATE_MAIN);
  });

  describe("Check for updates", () => {
    const checkBtn = () => within(toolbar()).getByRole("button", { name: "Check for updates" });

    /** GET answers `current` (what a refetch sees); the POST swaps it for `next`. */
    function withCheck(
      current: VersionInfo,
      next: VersionInfo | { fails: string; checkedAt: number | null },
    ) {
      let now = current;
      const posted: unknown[] = [];
      load({
        "/api/version": () => ({ status: 200, body: now }),
        "POST /api/version/check": (init: RequestInit | undefined) => {
          posted.push(JSON.parse(String(init?.body)));
          if ("fails" in next)
            return { status: 502, body: { error: next.fails, checkedAt: next.checkedAt } };
          now = next;
          return { status: 200, body: next };
        },
      });
      return posted;
    }

    it("sits between the version text and Update", async () => {
      load({ "/api/version": version() });
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      const all = [...toolbar().querySelectorAll("span.s, button")].map((e) => e.textContent);
      expect(all.slice(-4)).toEqual([
        "Version 0123456 · 3 commits behind main · checked just now",
        "Check for updates",
        "Update",
        "Update log",
      ]);
    });

    it("posts {}, is disabled meanwhile, toasts the count, and shows the refreshed text", async () => {
      const posted = withCheck(
        version({
          behind: 0,
          canUpdate: false,
          reason: UP_TO_DATE_MAIN,
          checkedAt: NOW - 60_000 * 30,
        }),
        version({ behind: 2, canUpdate: true, reason: null, checkedAt: NOW }),
      );
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText("Version 0123456 · checked 30 min ago");
      expect((updateBtn() as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(checkBtn());
      expect((checkBtn() as HTMLButtonElement).disabled).toBe(true);
      await waitFor(() => expect(posted).toEqual([{}]));
      expect(await screen.findByText("2 commits behind main.")).toBeTruthy();
      expect(
        await within(toolbar()).findByText(
          "Version 0123456 · 2 commits behind main · checked just now",
        ),
      ).toBeTruthy();
      expect((updateBtn() as HTMLButtonElement).disabled).toBe(false);
      expect((checkBtn() as HTMLButtonElement).disabled).toBe(false);
    });

    it("toasts Up to date with main. and the singular count", async () => {
      withCheck(version(), version({ behind: 0, canUpdate: false, reason: UP_TO_DATE_MAIN }));
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      fireEvent.click(checkBtn());
      expect(await screen.findByText(UP_TO_DATE_MAIN)).toBeTruthy();
      cleanup();
      withCheck(version({ behind: 0 }), version({ behind: 1 }));
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      fireEvent.click(checkBtn());
      expect(await screen.findByText("1 commit behind main.")).toBeTruthy();
    });

    it.each([
      [NOW - 4 * MIN, "Could not reach origin; last checked 4 min ago."],
      [null, "Could not reach origin; no earlier check."],
    ])(
      "toasts a 502 in relative time (checkedAt %s), and enables the button again",
      async (checkedAt, text) => {
        withCheck(version(), {
          fails: "Could not reach origin; last checked 2026-10-20T10:00Z.",
          checkedAt,
        });
        render(<Toast />);
        at("sessions");
        await within(toolbar()).findByText(/^Version/);
        fireEvent.click(checkBtn());
        expect(await screen.findByText(text)).toBeTruthy();
        expect(screen.queryByText(UP_TO_DATE_MAIN)).toBeNull();
        expect((checkBtn() as HTMLButtonElement).disabled).toBe(false);
      },
    );

    it("toasts that it could not compare when the count is null", async () => {
      withCheck(version(), version({ behind: null, canUpdate: false, reason: "not on main" }));
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      fireEvent.click(checkBtn());
      expect(await screen.findByText("Could not compare with main.")).toBeTruthy();
    });

    it("does not say up to date when nothing is behind but the reason is not the up-to-date one", async () => {
      withCheck(version(), version({ behind: 0, canUpdate: true, reason: null }));
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      fireEvent.click(checkBtn());
      expect(await screen.findByText("No new commits on main.")).toBeTruthy();
      expect(screen.queryByText(UP_TO_DATE_MAIN)).toBeNull();
    });

    it.each([PREVIEW_SERVER, UPDATE_UNAVAILABLE])(
      "disables Check, with the reason as its title: %s",
      async (reason) => {
        load({ "/api/version": version({ canUpdate: false, reason }) });
        at("sessions");
        await within(toolbar()).findByText(/^Version/);
        const b = checkBtn() as HTMLButtonElement;
        expect(b.disabled).toBe(true);
        expect(b.title).toBe(reason);
      },
    );
  });

  it("confirms, posts {}, and on 202 toasts that the HUD reconnects", async () => {
    const posted: unknown[] = [];
    load({
      "/api/version": version(),
      "POST /api/update": (init: RequestInit | undefined) => {
        posted.push(JSON.parse(String(init?.body)));
        return { status: 202, body: { restarting: true } };
      },
    });
    render(<Toast />);
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(updateBtn());
    expect(ask).toHaveBeenLastCalledWith(
      "Update to the latest main and restart? Crew runs resume after the restart.",
    );
    expect(posted).toEqual([]);
    fireEvent.click(updateBtn());
    await waitFor(() => expect(posted).toEqual([{}]));
    expect(
      await screen.findByText("Updating… the HUD reconnects when the hub is back."),
    ).toBeTruthy();
    expect((updateBtn() as HTMLButtonElement).disabled).toBe(true);
    ask.mockRestore();
  });

  it("toasts the server's reason when the update is refused or fails", async () => {
    load({
      "/api/version": version(),
      "POST /api/update": () => ({
        status: 500,
        body: { error: "update failed at build; see update.log" },
      }),
    });
    render(<Toast />);
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(updateBtn());
    expect(await screen.findByText("update failed at build; see update.log")).toBeTruthy();
    expect((updateBtn() as HTMLButtonElement).disabled).toBe(false);
    ask.mockRestore();
  });

  it.each([
    [500, "update failed at install; see update.log"],
    [409, "Update waits for you: pnpm needs to rebuild node_modules."],
  ])(
    "opens the update log when an update answers %i, so the reason is on the page",
    async (status, error) => {
      load({
        "/api/version": version(),
        "/api/update/log": {
          text: "$ pnpm install --frozen-lockfile\n[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted\n",
        },
        "POST /api/update": () => ({ status, body: { error, logged: true } }),
      });
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(updateBtn());
      const dialog = await screen.findByRole("dialog", { name: "Update log" });
      expect(
        await within(dialog).findByText(/ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/),
      ).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog", { name: "Update log" })).toBeNull();
      ask.mockRestore();
    },
  );

  it("leaves the log closed for a refusal the log does not record, and for other failures", async () => {
    for (const [status, body] of [
      [409, { error: "the checkout has uncommitted changes", logged: false }],
      [502, { error: "origin unreachable" }],
    ] as const) {
      load({
        "/api/version": version(),
        "/api/update/log": { text: "an older update\n" },
        "POST /api/update": () => ({ status, body }),
      });
      render(<Toast />);
      at("sessions");
      await within(toolbar()).findByText(/^Version/);
      const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(updateBtn());
      expect(await screen.findByText(body.error)).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "Update log" })).toBeNull();
      ask.mockRestore();
      cleanup();
    }
  });

  it("returns focus to the Update log button after Close", async () => {
    load({ "/api/version": version(), "/api/update/log": { text: "x\n" } });
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    const button = within(toolbar()).getByRole("button", { name: "Update log" });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Update log" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("shows the last update's log from the toolbar, or says none has run", async () => {
    load({ "/api/version": version(), "/api/update/log": { text: null } });
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Update log" }));
    const dialog = await screen.findByRole("dialog", { name: "Update log" });
    expect(await within(dialog).findByText("No update has run on this hub yet.")).toBeTruthy();
    cleanup();
    load({ "/api/version": version({ canUpdate: false, reason: UPDATE_UNAVAILABLE }) });
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    expect(within(toolbar()).queryByRole("button", { name: "Update log" })).toBeNull();
  });

  it("toasts when the hub is already up to date", async () => {
    load({
      "/api/version": version({ behind: 0 }),
      "POST /api/update": () => ({ status: 200, body: { upToDate: true } }),
    });
    render(<Toast />);
    at("sessions");
    await within(toolbar()).findByText(/^Version/);
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(updateBtn());
    expect(await screen.findByText(UP_TO_DATE_MAIN)).toBeTruthy();
    ask.mockRestore();
  });

  it("shows no version when it cannot be read", async () => {
    load();
    at("sessions");
    await screen.findByRole("region", { name: "shop-app · observed loops" });
    expect(within(toolbar()).queryByRole("button", { name: "Update" })).toBeNull();
  });
});
