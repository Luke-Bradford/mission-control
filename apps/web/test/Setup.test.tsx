import {
  type ConfigView,
  type Crew,
  type CrewChanges,
  GITHUB_SLOWED_PREFIX,
  type HealthRow,
  type LimitRow,
  PREVIEW_SERVER,
  RETRY_NOTE,
  type RepoPreview,
  type RepoRulesView,
  UP_TO_DATE_MAIN,
  UPDATE_UNAVAILABLE,
  type VersionInfo,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Setup } from "../src/pages/Setup.tsx";
import { SETUP_TABS, type SetupTab } from "../src/router.ts";
import {
  FOLDER_FREE,
  RELOADED,
  refusedText,
  removedText,
  SESSIONS_NOTE,
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

const repoRules = (planSignoff: "every" | "larger" | "never"): RepoRulesView =>
  ({
    base: "b".repeat(64),
    rules: Object.fromEntries(
      [
        "pick_from",
        "needs",
        "areas",
        "promote_backlog",
        "plan_signoff",
        "protected",
        "hard_rules",
        "hard_rules_by",
        "commands.writer",
        "commands.review",
        "full_suite",
        "required_checks",
        "checks",
        "uat.labels",
        "uat.paths",
        "always_ask",
        "autonomy",
        "flight_powers",
      ].map((key) => [
        key,
        { value: key === "plan_signoff" ? planSignoff : "", source: "default" },
      ]),
    ),
  }) as unknown as RepoRulesView;

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
    "/api/settings/crew-pause": null,
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
  it("the dependency-order sidebar routes its seven sections", async () => {
    load();
    render(<Setup tab="sessions" />);
    const tabs = screen.getByRole("navigation", { name: "Setup sections" });
    expect(SETUP_TABS).toHaveLength(8);
    fireEvent.click(within(tabs).getByRole("button", { name: "Accounts" }));
    expect(window.location.pathname).toBe("/setup/accounts");
    fireEvent.click(within(tabs).getByRole("button", { name: "Roles & guards" }));
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

  it("Sessions: each seat shows only recorded model, effort, budget and CLI version", async () => {
    load({
      "/api/config": SESSIONS_CFG,
      "/api/crew?shape=summary": {
        rows: [
          seatRow({ cli: { version: "2.1.302", effort: "high", budgetUsd: 12.5 } }),
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
    expect(guido.textContent).toContain("claude-opus-4-1 · high · Budget $12.50 · CLI 2.1.302");
    expect(described(guido)).toContain("claude-opus-4-1 · high · Budget $12.50 · CLI 2.1.302");
    const retro = within(p).getByRole("button", { name: /^retro-1$/ });
    expect(described(retro)).toContain("claude-opus-4-1");
    expect(described(retro)).not.toContain("default");
    expect(described(retro)).not.toContain("Budget");
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
    expect(
      (await screen.findByText("Crew is off: crew lock held by pid 123")).getAttribute("role"),
    ).toBe("status");
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
    it.each(["s1", "unknown"])(
      "?add=%s on Repos & seats opens only the matching session's seat form",
      async (id) => {
        load({
          "/api/config": SESSIONS_CFG,
          "/api/crew/changes": CHANGES,
          "/api/accounts/models": [],
        });
        window.history.replaceState(null, "", `/setup/repos?add=${id}`);
        render(<Setup tab="repos" />);
        await settled(fetchFn, "/api/config");
        if (id === "unknown") {
          await settled(fetchFn, "/api/crew/changes");
          expect(screen.queryByRole("form", { name: "Add seat" })).toBeNull();
        } else {
          expect(await screen.findByRole("form", { name: "Add seat" })).toBeTruthy();
          expect(window.location.search).toBe("");
        }
      },
    );

    it("?edit= on Repos & seats opens that seat's edit form", async () => {
      load({
        "/api/config": SESSIONS_CFG,
        "/api/crew/changes": CHANGES,
        "/api/accounts/models": [],
      });
      window.history.replaceState(null, "", "/setup/repos?edit=s1:guido-1");
      render(<Setup tab="repos" />);
      expect(await screen.findByRole("form", { name: "Edit guido-1" })).toBeTruthy();
    });

    it("?edit= waits for the crew changes, so saving another field keeps the seat's effort", async () => {
      load({
        "/api/config": SESSIONS_CFG,
        "/api/crew/changes": CHANGES,
        "/api/accounts/models": [],
        "POST /api/crew/sessions/s1/seats": () => ({
          status: 200,
          body: { backup: "b", changes: { ...CHANGES, applied: [] } },
        }),
      });
      const answer = fetchFn.getMockImplementation();
      if (!answer) throw new Error("no fetch implementation");
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const withEffort = {
        ...CHANGES,
        sessions: [{ id: "s1", seats: [{ ...GUIDO_SEAT, effort: "high" }, RETRO_SEAT] }],
      };
      fetchFn.mockImplementation(async (input, init) => {
        if (input !== "/api/crew/changes") return answer(input, init);
        await gate;
        return new Response(JSON.stringify(withEffort), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      window.history.replaceState(null, "", "/setup/repos?edit=s1:guido-1");
      render(<Setup tab="repos" />);
      expect(await screen.findByText("Loading the seats…")).toBeTruthy();
      expect(screen.queryByRole("form", { name: "Edit guido-1" })).toBeNull();
      release();
      const form = await screen.findByRole("form", { name: "Edit guido-1" });
      fireEvent.change(within(form).getByLabelText("Area"), { target: { value: "docs/**" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
      await waitFor(() =>
        expect(
          fetchFn.mock.calls.some(
            ([p, i]) => p === "/api/crew/sessions/s1/seats" && i?.method === "POST",
          ),
        ).toBe(true),
      );
      const call = fetchFn.mock.calls.find(
        ([p, i]) => p === "/api/crew/sessions/s1/seats" && i?.method === "POST",
      );
      const sent = JSON.parse(String(call?.[1]?.body));
      expect(sent.seats[0]).toMatchObject({ id: "guido-1", effort: "high", area: ["docs/**"] });
    });

    it("Sessions: Add agent and Edit open the Repos & seats editor", async () => {
      const p = await seats();
      fireEvent.click(within(p).getByRole("button", { name: "Add agent" }));
      expect(window.location.pathname + window.location.search).toBe("/setup/repos?add=s1");
      window.history.replaceState(null, "", "/setup/sessions");
      const row = within(p).getByRole("row", { name: /guido-1/ });
      fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
      expect(window.location.pathname + window.location.search).toBe(
        "/setup/repos?edit=s1%3Aguido-1",
      );
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
    const _open = async (p: HTMLElement) => {
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

    it("a refused reload shows the alert", async () => {
      await seats({
        "POST /api/config/reload": () => ({ status: 409, body: { error: "crew is off" } }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Reload config.yaml" }));
      expect((await screen.findByText(refusedText("crew is off"))).getAttribute("role")).toBe(
        "alert",
      );
    });

    it("config.yaml state", async () => {
      await seats({
        "/api/crew/changes": { ...CHANGES, error: "bad yaml", restartNeeded: ["loops"] },
        "POST /api/config/reload": () => ({ status: 200, body: { ...CHANGES, applied: [] } }),
      });
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

describe("Setup is read-only (except Hub, Repos, Sessions, Accounts and Safety)", () => {
  it.each(
    SETUP_TABS.filter(
      (t) => t !== "hub" && t !== "repos" && t !== "sessions" && t !== "accounts" && t !== "access",
    ),
  )("%s: no enabled field, and no button posts", async (tab) => {
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
      // the repo picker chooses which repo's rules to read; it changes nothing
      if (tab === "roles" && el.closest(".rg-picker")) continue;
      expect((el as HTMLInputElement).disabled).toBe(true);
    }
    for (const b of body.querySelectorAll("button")) fireEvent.click(b);
    const posts = fetchFn.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
    expect(posts).toEqual([]);
  });
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

  it("shows each repo's plan sign-off setting and saves a change to it", async () => {
    const writes: string[] = [];
    load({
      "/api/repos/shop-app/rules": repoRules("every"),
      "POST /api/repos/shop-app/setup": () => {
        writes.push("setup");
        return { status: 200, body: { backup: "c.bak" } };
      },
      "POST /api/repos/shop-app/rules": () => {
        writes.push("rules");
        return { status: 200, body: {} };
      },
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    const select = (await within(card).findByLabelText("Plan sign-off")) as HTMLSelectElement;
    expect(select.value).toBe("every");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Every ticket",
      "Larger work only",
      "Never",
    ]);
    fireEvent.change(select, { target: { value: "never" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save guidance" }));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(
        ([path, init]) => path === "/api/repos/shop-app/rules" && init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        rules: { plan_signoff: "never" },
      });
      expect(writes).toEqual(["rules", "setup"]);
    });
  });

  it("keeps an account picked before the repo rules arrive", async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => {};
    load({
      "/api/repos/shop-app/rules": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    const account = within(card).getByLabelText("Default account") as HTMLSelectElement;
    fireEvent.change(account, { target: { value: "codex-main" } });
    await act(async () => {
      answer({ status: 200, body: repoRules("every") });
    });
    expect(((await within(card).findByLabelText("Plan sign-off")) as HTMLSelectElement).value).toBe(
      "every",
    );
    expect(account.value).toBe("codex-main");
  });

  it("does not write plan rules when the setting is unchanged", async () => {
    load({
      "/api/repos/shop-app/rules": repoRules("every"),
      "POST /api/repos/shop-app/setup": () => ({ status: 200, body: { backup: "c.bak" } }),
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    await within(card).findByLabelText("Plan sign-off");
    fireEvent.click(within(card).getByRole("button", { name: "Save guidance" }));
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(
          ([path, init]) => path === "/api/repos/shop-app/setup" && init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(
      fetchFn.mock.calls.some(
        ([path, init]) => path === "/api/repos/shop-app/rules" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("does not save plan sign-off until the repo rules load", async () => {
    load({
      "POST /api/repos/shop-app/setup": () => ({ status: 200, body: { backup: "c.bak" } }),
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    expect(within(card).queryByLabelText("Plan sign-off")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Save guidance" }));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([path]) => path === "/api/repos/shop-app/setup");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty("planSignOff");
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
    expect(
      (await within(screen.getByLabelText("Add repo")).findByRole("alert")).textContent,
    ).toContain("origin does not match");
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
    expect(
      (await within(screen.getByLabelText("Add repo")).findByRole("alert")).textContent,
    ).toContain("could not write config.yaml");
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

describe("Setup › Repos & seats: the add-repo steps", () => {
  const form = () => screen.getByRole("form", { name: "Add repo" });
  const type = (label: string, value: string) =>
    fireEvent.change(within(form()).getByLabelText(label), { target: { value } });
  const press = (name: string) => fireEvent.click(within(form()).getByRole("button", { name }));
  const posts = (path: string) =>
    fetchFn.mock.calls.filter(([p, i]) => p === path && i?.method === "POST").length;
  async function toChecks(over: Record<string, unknown> = {}) {
    load({
      "POST /api/repos/preview": PREVIEW,
      "POST /api/repos/checkout-preview": { ok: true },
      "POST /api/repos/onboard": { backup: "c.bak" },
      ...over,
    });
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    type("GitHub repo", "octo-org/mission");
    type("Project number", "4");
    type("Repo id", "mission");
    press("Next: checkout");
    type("Checkout folder", "/work/mission");
    press("Next: live checks");
  }
  const toMode = async (over: Record<string, unknown> = {}) => {
    await toChecks(over);
    press("Run live checks");
    await screen.findByText(/Project board verified/);
  };

  it("keyboard focus follows each step, and Cancel returns to the opener", async () => {
    load({ "POST /api/repos/preview": PREVIEW, "POST /api/repos/checkout-preview": { ok: true } });
    at("repos");
    const opener = await screen.findByRole("button", { name: "+ Add repo" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(within(form()).getByLabelText("GitHub repo"));
    type("GitHub repo", "octo-org/mission");
    type("Project number", "4");
    type("Repo id", "mission");
    fireEvent.submit(form());
    expect(document.activeElement).toBe(within(form()).getByLabelText("Checkout folder"));
    type("Checkout folder", "/work/mission");
    fireEvent.submit(form());
    await within(form()).findByRole("list", { name: "Live check results" });
    expect(document.activeElement).toBe(
      within(form()).getByRole("button", { name: "Run live checks" }),
    );
    press("Cancel");
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("an invalid Next explains what to fix instead of staying silent", async () => {
    load();
    at("repos");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add repo" }));
    type("GitHub repo", "not a repo");
    press("Next: checkout");
    const summary = within(form()).getByRole("region", { name: "Fix before continuing" });
    expect(summary.textContent).toContain("owner/name");
    expect(summary.textContent).toContain("Project number");
    expect(summary.textContent).toContain("Repo id");
    expect(document.activeElement).toBe(summary);
    expect(within(form()).getByLabelText("GitHub repo").getAttribute("aria-invalid")).toBe("true");
    // still on step 1, and the entry is kept
    expect((within(form()).getByLabelText("GitHub repo") as HTMLInputElement).value).toBe(
      "not a repo",
    );
    press("Next: checkout");
    expect(within(form()).queryByLabelText("Branch")).toBeNull();
  });

  it("step summaries show the earlier answers and the checks list one row per request", async () => {
    await toChecks();
    expect(form().textContent).toContain("octo-org/mission · project 4 · id mission");
    expect(form().textContent).toContain("/work/mission · branch main");
    const checks = within(within(form()).getByRole("list", { name: "Live check results" }));
    expect(checks.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "GitHub repo and Project boardNot run",
      "Checkout folder and branchNot run",
    ]);
  });

  it("a failed check stays on step 3, marks the failing request, and keeps every entry", async () => {
    await toChecks({
      "POST /api/repos/checkout-preview": () => ({
        status: 400,
        body: { error: "origin does not match" },
      }),
    });
    press("Run live checks");
    const summary = await within(form()).findByRole("region", { name: "A check failed" });
    expect(summary.textContent).toContain("origin does not match");
    const rows = within(form()).getByRole("list", { name: "Live check results" });
    expect(
      within(rows)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["GitHub repo and Project boardPass", "Checkout folder and branchFail"]);
    expect(within(form()).getByRole("button", { name: "Run live checks" })).toBeTruthy();
    press("Back");
    expect((within(form()).getByLabelText("Checkout folder") as HTMLInputElement).value).toBe(
      "/work/mission",
    );
    expect(posts("/api/repos/onboard")).toBe(0);
  });

  it("a refused repo check marks the first request and leaves the second not run", async () => {
    await toChecks({
      "POST /api/repos/preview": () => ({ status: 404, body: { error: "Project 4 not found" } }),
    });
    press("Run live checks");
    await within(form()).findByText(/Project 4 not found/);
    const rows = within(form()).getByRole("list", { name: "Live check results" });
    expect(
      within(rows)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["GitHub repo and Project boardFail", "Checkout folder and branchNot run"]);
  });

  it("a lost connection during the live checks says nothing was saved, and keeps the entries", async () => {
    await toChecks();
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetchFn.mockImplementation(async (input, init) => {
      if (input === "/api/repos/preview") throw new TypeError("Failed to fetch");
      return answer(input, init);
    });
    press("Run live checks");
    const summary = await within(form()).findByRole("region", { name: "Check did not finish" });
    expect(summary.textContent).toContain("Nothing was saved");
    expect(summary.textContent).not.toContain("saving again");
    expect(document.activeElement).toBe(summary);
    const rows = within(form()).getByRole("list", { name: "Live check results" });
    expect(
      within(rows)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["GitHub repo and Project boardFail", "Checkout folder and branchNot run"]);
    press("Back");
    expect((within(form()).getByLabelText("Checkout folder") as HTMLInputElement).value).toBe(
      "/work/mission",
    );
  });

  it("a server error at the live checks is a failed check, not a dropped connection", async () => {
    await toChecks({
      "POST /api/repos/preview": () => ({
        status: 502,
        body: { error: "github: no CI workflow directory on octo-org/mission" },
      }),
    });
    press("Run live checks");
    const summary = await within(form()).findByRole("region", { name: "A check failed" });
    expect(summary.textContent).toContain("no CI workflow directory");
    expect(summary.textContent).toContain("Nothing was saved");
    expect(summary.textContent).not.toContain("connection dropped");
  });

  it("converting a second repo starts a fresh form for that repo", async () => {
    load();
    at("repos");
    const first = expandCard(await screen.findByLabelText("shop-app"));
    fireEvent.click(within(first).getByRole("button", { name: "Convert to crew repo" }));
    expect(
      (
        within(screen.getByLabelText("Convert shop-app to crew repo")).getByLabelText(
          "GitHub repo",
        ) as HTMLInputElement
      ).value,
    ).toBe("octo-org/shop-app");
    const second = expandCard(await screen.findByLabelText("site-builder"));
    fireEvent.click(within(second).getByRole("button", { name: "Convert to crew repo" }));
    expect(
      (
        within(screen.getByLabelText("Convert site-builder to crew repo")).getByLabelText(
          "GitHub repo",
        ) as HTMLInputElement
      ).value,
    ).toBe("octo-org/site-builder");
  });

  it("a double press of Run live checks sends one pair of requests", async () => {
    await toChecks();
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText(/Project board verified/);
    expect(posts("/api/repos/preview")).toBe(1);
    expect(posts("/api/repos/checkout-preview")).toBe(1);
  });

  it("the last step lists what will be written, and a double press adds once", async () => {
    await toMode();
    fireEvent.change(within(form()).getByLabelText("Mode"), { target: { value: "crew" } });
    expect(form().textContent).toContain("Repo mission (octo-org/mission, project 4) added");
    expect(form().textContent).toContain("Crew session mission on a shared checkout");
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(posts("/api/repos/onboard")).toBe(1));
  });

  it("a refused add keeps the entries and says so in the form", async () => {
    await toMode({
      "POST /api/repos/onboard": () => ({ status: 409, body: { error: "mission already exists" } }),
    });
    press("Add repo");
    const summary = await within(form()).findByRole("region", { name: "Not saved" });
    expect(summary.textContent).toContain("mission already exists");
    expect(form().textContent).toContain("Repo mission");
    expect(within(form()).getByRole("button", { name: "Add repo" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("a lost connection on the last write says the result is unknown and rereads the config", async () => {
    await toMode();
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetchFn.mockImplementation(async (input, init) => {
      if (input === "/api/repos/onboard") throw new TypeError("Failed to fetch");
      return answer(input, init);
    });
    const before = fetchFn.mock.calls.filter(([p]) => p === "/api/config").length;
    press("Add repo");
    const summary = await within(form()).findByRole("region", { name: "Result unknown" });
    expect(summary.textContent).toContain("The result is unknown");
    await waitFor(() =>
      expect(fetchFn.mock.calls.filter(([p]) => p === "/api/config").length).toBeGreaterThan(
        before,
      ),
    );
  });
});

describe("Setup › Repos & seats: the seat form", () => {
  const SEAT = {
    id: "guido-1",
    role: "GUIDO",
    accountId: "claude-main",
    model: "sonnet",
    area: ["apps/**"],
  };
  const CHANGES = {
    sessions: [{ id: "s1", seats: [SEAT] }],
    pending: [],
    restartNeeded: [],
    error: null,
    checkedAt: NOW,
  };
  const SAVED = { backup: "config.yaml.bak-x", changes: { ...CHANGES, applied: [] } };
  const SEATS_PATH = "/api/crew/sessions/s1/seats";
  const posts = () =>
    fetchFn.mock.calls.filter(([p, i]) => p === SEATS_PATH && i?.method === "POST").length;
  async function openForm(over: Record<string, unknown> = {}, edit = false) {
    load({
      "/api/config": { ...CREW_CONFIG, loops: CFG.loops },
      "/api/crew/changes": CHANGES,
      [`POST ${SEATS_PATH}`]: SAVED,
      ...over,
    });
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    if (edit) {
      // the seat list is the pending one from /api/crew/changes once that has loaded
      await within(card).findByText(String(over.waitFor ?? "sonnet"));
      const row = within(card).getByRole("row", { name: /guido-1/ });
      fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
      return screen.findByRole("form", { name: "Edit guido-1" });
    }
    fireEvent.click(within(card).getByRole("button", { name: "+ Add seat to this repo" }));
    return screen.findByRole("form", { name: "Add seat" });
  }
  const fill = (form: HTMLElement, id: string) =>
    fireEvent.change(within(form).getByLabelText("Call sign"), { target: { value: id } });

  it("the seat form opens at its first control and Cancel returns to the add button", async () => {
    const form = await openForm();
    expect(document.activeElement).toBe(within(form).getByLabelText("Call sign"));
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "+ Add seat to this repo" }),
      ),
    );
  });

  it("the long selects carry their full chosen text as a title", async () => {
    const form = await openForm();
    for (const label of ["Role", "Account", "Model"]) {
      const select = within(form).getByLabelText(label) as HTMLSelectElement;
      expect(select.title).toBe(select.selectedOptions[0]?.textContent);
      expect(select.title).not.toBe("");
    }
  });

  it("invalid seat submit explains itself", async () => {
    const form = await openForm();
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    const summary = await within(form).findByRole("region", { name: "Fix before saving" });
    expect(summary.textContent).toContain("Call sign");
    expect(document.activeElement).toBe(summary);
    expect(within(form).getByLabelText("Call sign").getAttribute("aria-invalid")).toBe("true");
    expect(posts()).toBe(0);
  });

  // Both forms: F11 adds a seat, F12 edits guido-1. `touch` makes a change the form must keep.
  const FORMS = [
    { name: "F11 add", edit: false, label: "Add seat" },
    { name: "F12 edit", edit: true, label: "Edit guido-1" },
  ] as const;
  const touch = (form: HTMLElement, edit: boolean) => {
    if (edit) fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "INCO" } });
    else fill(form, "inco-2");
  };
  const kept = (form: HTMLElement, edit: boolean) =>
    edit
      ? (within(form).getByLabelText("Role") as HTMLSelectElement).value
      : (within(form).getByLabelText("Call sign") as HTMLInputElement).value;
  const keptValue = (edit: boolean) => (edit ? "INCO" : "inco-2");

  it.each(FORMS)(
    "$name: a refused save is shown in the form and keeps what was typed",
    async ({ edit, label }) => {
      const form = await openForm(
        {
          [`POST ${SEATS_PATH}`]: () => ({
            status: 409,
            body: { error: "The seats changed in config.yaml; reread them." },
          }),
        },
        edit,
      );
      touch(form, edit);
      fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
      const summary = await within(form).findByRole("region", { name: "Not saved" });
      expect(summary.textContent).toContain("The seats changed in config.yaml; reread them.");
      expect(document.activeElement).toBe(summary);
      expect(kept(form, edit)).toBe(keptValue(edit));
      expect(screen.getByRole("form", { name: label })).toBeTruthy();
    },
  );

  // The summary is rendered by a save that finished after the click, so React commits it outside
  // any event. Focus must already be on it when it first appears in the DOM; a test that looks a
  // moment later (as the one above does) would pass or fail on how busy the machine is.
  it.each(FORMS)(
    "$name: focus is on the refused-save summary the moment it appears",
    async ({ edit }) => {
      const form = await openForm(
        { [`POST ${SEATS_PATH}`]: () => ({ status: 409, body: { error: "Refused." } }) },
        edit,
      );
      touch(form, edit);
      let focusedOnAppear: Element | null = null;
      const watch = new MutationObserver(() => {
        const found = form.querySelector(".fsum");
        if (found && focusedOnAppear === null) focusedOnAppear = document.activeElement;
      });
      watch.observe(form, { childList: true, subtree: true });
      fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
      const summary = await within(form).findByRole("region", { name: "Not saved" });
      watch.disconnect();
      expect(focusedOnAppear).toBe(summary);
    },
  );

  it.each(FORMS)(
    "$name: a lost connection says the result is unknown, rereads, and keeps the entries",
    async ({ edit }) => {
      const form = await openForm({}, edit);
      fetchFn.mockImplementation(async (input, init) => {
        if (init?.method === "POST") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(input === "/api/config" ? CREW_CONFIG : CHANGES));
      });
      touch(form, edit);
      fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
      const summary = await within(form).findByRole("region", { name: "Result unknown" });
      expect(summary.textContent).toContain("The result is unknown");
      expect(kept(form, edit)).toBe(keptValue(edit));
    },
  );

  it.each(FORMS)("$name: a double submit sends one request", async ({ edit, label }) => {
    const form = await openForm({}, edit);
    let finish!: (r: Response) => void;
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetchFn.mockImplementation((input, init) =>
      init?.method === "POST"
        ? new Promise<Response>((done) => {
            finish = done;
          })
        : answer(input, init),
    );
    touch(form, edit);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(posts()).toBe(1);
    await act(async () => finish(new Response(JSON.stringify(SAVED))));
    await waitFor(() => expect(screen.queryByRole("form", { name: label })).toBeNull());
    expect(posts()).toBe(1);
  });

  it("a seat that leaves config.yaml mid-edit stays an edit and is only ever added back", async () => {
    const form = await openForm(
      {
        [`POST ${SEATS_PATH}`]: () => ({ status: 409, body: { error: "guido-1 was removed." } }),
      },
      true,
    );
    fireEvent.change(within(form).getByLabelText("Model"), { target: { value: "sonnet" } });
    // the reread after the conflict finds the seat gone
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetchFn.mockImplementation(async (input, init) =>
      input === "/api/crew/changes"
        ? new Response(JSON.stringify({ ...CHANGES, sessions: [{ id: "s1", seats: [] }] }))
        : answer(input, init),
    );
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    await within(form).findByRole("region", { name: "Not saved" });
    const gone = await screen.findByText(/guido-1 is no longer in config.yaml/);
    expect(gone).toBeTruthy();
    expect(screen.getByRole("form", { name: "Edit guido-1" })).toBeTruthy();
    expect(within(form).getByLabelText("Call sign")).toHaveProperty("disabled", true);
    fetchFn.mockImplementation(answer);
    fireEvent.click(within(form).getByRole("button", { name: "Add it back" }));
    await waitFor(() => expect(posts()).toBe(2));
    const sent = fetchFn.mock.calls
      .filter(([p, i]) => p === SEATS_PATH && i?.method === "POST")
      .map(([, i]) => JSON.parse(String(i?.body)));
    expect(sent[1].base).toEqual([]);
    expect(sent[1].seats).toEqual([SEAT]);
  });

  it("an unreadable model list says why, with a retry, instead of 'No discovered models'", async () => {
    const form = await openForm({
      "/api/accounts/models": () => ({ status: 503, body: { error: "catalogue down" } }),
    });
    await waitFor(() => expect(form.textContent).toContain("catalogue down"));
    expect(form.textContent).not.toContain("No discovered models");
    expect(within(form).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry rereads the model list and fills the Model select", async () => {
    const form = await openForm({
      "/api/accounts/models": () => ({ status: 503, body: { error: "catalogue down" } }),
    });
    await waitFor(() => expect(form.textContent).toContain("catalogue down"));
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetchFn.mockImplementation(async (input, init) =>
      input === "/api/accounts/models"
        ? new Response(
            JSON.stringify([
              { accountId: "claude-main", models: [{ model: "sonnet", efforts: [] }] },
            ]),
          )
        : answer(input, init),
    );
    fireEvent.click(within(form).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect((within(form).getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet"),
    );
    expect(form.textContent).not.toContain("catalogue down");
  });

  it("while the model list loads, Model says so and Save explains the wait", async () => {
    load({
      "/api/config": { ...CREW_CONFIG, loops: CFG.loops },
      "/api/crew/changes": CHANGES,
    });
    const answer = fetchFn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    fetchFn.mockImplementation((input, init) =>
      input === "/api/accounts/models" ? new Promise<Response>(() => {}) : answer(input, init),
    );
    at("repos");
    const card = expandCard(await screen.findByLabelText("shop-app"));
    fireEvent.click(within(card).getByRole("button", { name: "+ Add seat to this repo" }));
    const form = await screen.findByRole("form", { name: "Add seat" });
    const model = within(form).getByLabelText("Model") as HTMLSelectElement;
    expect(model.selectedOptions[0]?.textContent).toBe("Loading models…");
    fill(form, "inco-2");
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    const summary = await within(form).findByRole("region", { name: "Fix before saving" });
    expect(summary.textContent).toContain("still loading");
    expect(posts()).toBe(0);
  });

  it("with no models, the 'Model is required' link lands on Account, which can take focus", async () => {
    const form = await openForm({ "/api/accounts/models": [] });
    fill(form, "inco-2");
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    const summary = await within(form).findByRole("region", { name: "Fix before saving" });
    fireEvent.click(within(summary).getByRole("link", { name: /Model is required/ }));
    expect(document.activeElement).toBe(within(form).getByLabelText("Account"));
  });

  it("edit keeps the seat's id fixed and a retired model visible", async () => {
    const form = await openForm(
      {
        waitFor: "retired-x",
        "/api/crew/changes": {
          ...CHANGES,
          sessions: [{ id: "s1", seats: [{ ...SEAT, model: "retired-x" }] }],
        },
      },
      true,
    );
    expect(within(form).getByLabelText("Call sign")).toHaveProperty("disabled", true);
    expect((within(form).getByLabelText("Model") as HTMLSelectElement).value).toBe("retired-x");
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    await waitFor(() => expect(posts()).toBe(1));
    const sent = JSON.parse(
      String(
        fetchFn.mock.calls.find(([p, i]) => p === SEATS_PATH && i?.method === "POST")?.[1]?.body,
      ),
    );
    expect(sent.base).toEqual([{ ...SEAT, model: "retired-x" }]);
    expect(sent.seats[0].id).toBe("guido-1");
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

describe("Setup: first run, config status and restart", () => {
  const SETTINGS = {
    base: "b".repeat(64),
    values: { "operator.timezone": "UTC" },
    repos: {},
  };
  const EMPTY = { ...CFG, accounts: [], repos: [], loops: [], crew: undefined };

  it("First run lists the four steps for an empty config and hides when all are set", async () => {
    load({ "/api/config": EMPTY, "/api/config/settings": SETTINGS });
    at("hub");
    const panel = await screen.findByRole("region", { name: "First run" });
    for (const step of ["Time zone", "Accounts", "Crew folder", "First repo"])
      expect(
        within(panel).getByRole("img", { name: new RegExp(`^${step} (done|to do)$`) }),
      ).toBeTruthy();
    expect(within(panel).getByRole("img", { name: "Time zone done" })).toBeTruthy();
    expect(within(panel).getByRole("img", { name: "Crew folder to do" })).toBeTruthy();
    cleanup();
    load({
      "/api/config": CREW_CONFIG,
      "/api/config/settings": {
        ...SETTINGS,
        values: { ...SETTINGS.values, "crew.worktrees": "/tmp/crew" },
      },
    });
    at("hub");
    await screen.findByRole("region", { name: "Hub settings" });
    expect(screen.queryByRole("region", { name: "First run" })).toBeNull();
  });

  it.each(["hub", "sessions", "roles"] as const)(
    "shows restart-needed and the config error on the %s tab",
    async (tab) => {
      load({
        "/api/config/settings": SETTINGS,
        "/api/crew/changes": {
          sessions: [],
          pending: [],
          restartNeeded: ["poll"],
          error: "bad",
          checkedAt: NOW,
        },
      });
      at(tab);
      expect(await screen.findByText("Restart needed: poll.")).toBeTruthy();
      expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("bad"))).toBe(true);
    },
  );

  it("Restart asks first, then posts to the restart route", async () => {
    load({
      "/api/config/settings": SETTINGS,
      "POST /api/hub/restart": () => ({ status: 202, body: { restarting: true } }),
    });
    render(<Toast />);
    at("hub");
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const button = await screen.findByRole("button", { name: "Restart hub" });
    fireEvent.click(button);
    const restarts = () =>
      fetchFn.mock.calls.filter(([p, i]) => p === "/api/hub/restart" && i?.method === "POST");
    expect(restarts()).toHaveLength(0);
    fireEvent.click(button);
    expect(ask).toHaveBeenLastCalledWith(
      "Restart the hub now? Crew runs resume after the restart.",
    );
    await waitFor(() => expect(restarts()).toHaveLength(1));
    expect(
      await screen.findByText("Restarting… the HUD reconnects when the hub is back."),
    ).toBeTruthy();
    ask.mockRestore();
  });
});
