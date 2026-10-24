import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ROLES,
  COMMS_PREVIEW_MAX,
  COMMS_TEXT_MAX,
  commsCutMarker,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threadMessages } from "../src/comms.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { activity, configView, overview, runEventsIndex } from "../src/views.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-views-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_000_000_000;
const config = {
  loops: [{ id: "a1" }],
  repos: [{ id: "shop-app", github: "octo-org/shop-app", project: 2, statusMap: {} }],
} as unknown as CcConfig;

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  agentId: "a1",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - 3000,
  endedAt: NOW - 1000,
  status: "ok",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "shop-app",
  number: 41,
  title: "Quote cache",
  url: "https://github.com/octo-org/shop-app/pull/41",
  branch: "chore/cache",
  ticket: "shop-app#3349",
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: 1,
  updatedAt: 2,
  mergedAt: 3,
  headSha: null,
  mergeable: null,
  ...over,
});

describe("activity: what a run was about", () => {
  it("resolves the ticket through the run's PRs and carries the PRs and summary", () => {
    store.upsertPullRequests("shop-app", [pr()], 0);
    store.upsertRun(
      run({ prs: [{ repo: "octo-org/shop-app", number: 41 }], summary: "Cached quotes" }),
    );
    const events = activity(config, store, NOW);
    const end = events.find((e) => e.kind === "run-end");
    const start = events.find((e) => e.kind === "run-start");
    expect(end?.ref).toBe("shop-app#3349");
    expect(end?.summary).toBe("Cached quotes");
    expect(end?.text).toBe("ok · shop-app#3349 · Cached quotes");
    expect(end?.prs).toEqual([
      {
        repoId: "shop-app",
        number: 41,
        title: "Quote cache",
        url: "https://github.com/octo-org/shop-app/pull/41",
        state: "merged",
        ticket: "shop-app#3349",
      },
    ]);
    expect(start?.ref).toBe("shop-app#3349");
    expect(start?.text).toBe("started on shop-app#3349");
    expect(start?.prs).toHaveLength(1);
  });

  it("merges state changes and PRs opened and merged in time order, attributing a PR to its run's agent", () => {
    store.upsertPullRequests(
      "shop-app",
      [
        pr({ number: 41, createdAt: NOW - 5000, mergedAt: NOW - 2000 }),
        pr({ number: 42, title: "Other", state: "open", createdAt: NOW - 4000, mergedAt: null }),
        pr({ number: 40, title: "Old", createdAt: 1, mergedAt: 2 }),
      ],
      0,
    );
    store.upsertRun(run({ prs: [{ repo: "octo-org/shop-app", number: 41 }] }));
    store.addAgentEvent({
      agentId: "a1",
      at: NOW - 3000,
      from: "running",
      to: "stalled",
      text: "Running → Stalled: no output for 10 min",
    });
    const events = activity(config, store, NOW).filter((e) =>
      ["state", "pr-opened", "pr-merged"].includes(e.kind),
    );
    expect(events.map((e) => [e.at, e.kind, e.who, e.text, e.ref, e.url])).toEqual([
      [NOW - 2000, "pr-merged", "a1", "PR #41 merged: Quote cache", "shop-app#3349", pr().url],
      [NOW - 3000, "state", "a1", "Running → Stalled: no output for 10 min", null, null],
      [NOW - 4000, "pr-opened", "shop-app", "PR #42 opened: Other", "shop-app#3349", pr().url],
      [NOW - 5000, "pr-opened", "a1", "PR #41 opened: Quote cache", "shop-app#3349", pr().url],
    ]);
    expect(events.every((e) => e.prs.length === 0 && e.summary === null && e.status === null)).toBe(
      true,
    );
  });

  it("a run with nothing to say has no PRs, no summary and no suffix", () => {
    store.upsertRun(run());
    const end = activity(config, store, NOW).find((e) => e.kind === "run-end");
    expect(end).toMatchObject({ ref: null, prs: [], summary: null, text: "ok" });
  });
});

describe("activity: board moves", () => {
  const move = { runId: "r1", repoId: "shop-app", issue: 3349, column: "In review" } as const;

  it("shows a done move as `{ref} → {column}` and a failed one with its detail", () => {
    store.upsertRun(run({ id: "r1", agentId: "a1" }));
    const done = store.addBoardMove({ ...move, state: "pending", detail: null, at: NOW - 500 });
    store.finishBoardMove(done, "done", null, NOW - 400);
    const failed = store.addBoardMove({
      ...move,
      column: "Blocked",
      state: "pending",
      detail: null,
      at: NOW - 300,
    });
    store.finishBoardMove(failed, "failed", "github: HTTP 502", NOW - 200);
    const rows = activity(config, store, NOW).filter((e) => e.kind === "board");
    expect(rows).toEqual([
      {
        at: NOW - 200,
        who: "a1",
        kind: "board",
        text: "shop-app#3349 → Blocked failed: github: HTTP 502",
        ref: "shop-app#3349",
        url: null,
        status: null,
        prs: [],
        summary: null,
      },
      {
        at: NOW - 400,
        who: "a1",
        kind: "board",
        text: "shop-app#3349 → In review",
        ref: "shop-app#3349",
        url: null,
        status: null,
        prs: [],
        summary: null,
      },
    ]);
  });

  it("lists the hub's own automatic update lines", () => {
    store.addHubEvent("Updated to abc123 (auto)", NOW - 10);
    store.addHubEvent("Updated to old (auto)", 1);
    expect(activity(config, store, NOW).filter((e) => e.who === "hub")).toEqual([
      {
        at: NOW - 10,
        who: "hub",
        kind: "state",
        text: "Updated to abc123 (auto)",
        ref: null,
        url: null,
        status: null,
        prs: [],
        summary: null,
      },
    ]);
  });

  it("leaves out a pending move and one older than the window, and names the repo when the run is gone", () => {
    store.addBoardMove({ ...move, state: "pending", detail: null, at: NOW - 100 });
    const old = store.addBoardMove({ ...move, state: "pending", detail: null, at: 1 });
    store.finishBoardMove(old, "done", null, 2);
    expect(activity(config, store, NOW).filter((e) => e.kind === "board")).toEqual([]);
    const gone = store.addBoardMove({ ...move, state: "done", detail: null, at: NOW - 50 });
    expect(gone).toBeGreaterThan(0);
    expect(activity(config, store, NOW).find((e) => e.kind === "board")?.who).toBe("shop-app");
  });
});

describe("activity: comms", () => {
  it("serves a 3000-character message whole in its conversation and cuts only Activity", () => {
    const text = "x".repeat(3000);
    store.addComms({ at: NOW - 100, from: "CAPCOM", to: "guido-1", ticket: "mc#7", text });
    expect(store.comms(0)[0]?.text).toBe(text);
    expect(threadMessages(store, "guido-1", true)[0]?.text).toBe(text);
    expect(activity(config, store, NOW).find((e) => e.kind === "comms")?.text).toBe(
      `${"x".repeat(COMMS_PREVIEW_MAX - 1)}…`,
    );
  });

  it("keeps the storage marker in a conversation but out of its Activity preview", () => {
    const text = "x".repeat(COMMS_TEXT_MAX + 1);
    store.addComms({ at: NOW, from: "a1", to: "CAPCOM", ticket: "mc#7", text });
    expect(threadMessages(store, "a1", true)[0]?.text).toBe(
      `${"x".repeat(COMMS_TEXT_MAX)}${commsCutMarker(COMMS_TEXT_MAX, text.length)}`,
    );
    expect(activity(config, store, NOW).find((e) => e.kind === "comms")?.text).toBe(
      `${"x".repeat(COMMS_PREVIEW_MAX - 1)}…`,
    );
    expect(runEventsIndex(store, NOW).comms.get("a1")).toEqual([
      { at: NOW, from: "a1", ticket: "mc#7" },
    ]);
  });

  it("makes an Activity preview one line without changing the conversation", () => {
    const text = "  first\n\n  second\tthird  ";
    store.addComms({ at: NOW, from: "CAPCOM", to: "guido-1", ticket: null, text });
    expect(activity(config, store, NOW).find((e) => e.kind === "comms")?.text).toBe(
      "first second third",
    );
    expect(threadMessages(store, "guido-1", true)[0]?.text).toBe(text);
  });

  it("serves a hand-off inside the window as a comms row, and leaves out an older one", () => {
    store.addComms({ at: NOW - 100, from: "CAPCOM", to: "guido-1", ticket: "mc#7", text: "go" });
    store.addComms({ at: 1, from: "MC", to: "guido-1", ticket: null, text: "old" });
    expect(activity(config, store, NOW).filter((e) => e.kind === "comms")).toEqual([
      {
        at: NOW - 100,
        who: "CAPCOM",
        to: "guido-1",
        kind: "comms",
        text: "go",
        ref: "mc#7",
        url: null,
        status: null,
        prs: [],
        summary: null,
      },
    ]);
  });
});

describe("configView crew roles", () => {
  const cfg = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: "/w",
      maxSeats: 4,
      roles: {
        SCOUT: {
          prompt: "roles/SCOUT.md",
          model: "haiku",
          mode: "read-only",
          loop: "none",
          tools: [],
          here: "researcher",
        },
        ...BUILTIN_ROLES,
      },
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: "/c",
          seats: [
            { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
            { id: "fao-1", role: "FAO", accountId: "claude-main", model: "opus", area: [] },
          ],
        },
      ],
    },
  } as unknown as CcConfig;

  it("lists the roles sorted by name, and each seat's loop", () => {
    const crew = configView(cfg).crew;
    expect(crew?.roles?.map((r) => r.name)).toEqual([
      "FAO",
      "FLIGHT",
      "GUIDO",
      "INCO",
      "RETRO",
      "SCOUT",
    ]);
    expect(crew?.roles?.find((r) => r.name === "FAO")).toEqual({
      name: "FAO",
      prompt: "roles/FAO.md",
      model: "opus",
      mode: "read-only",
      loop: "plan",
      tools: ["report_plan", "read_ticket"],
      here: "planner: writes each ticket's plan for the developers",
    });
    expect(crew?.sessions[0]?.seats.map((s) => s.loop)).toEqual(["build", "plan"]);
  });
});

describe("crew seats in overview and activity", () => {
  const crewConfig = {
    ...config,
    crew: {
      worktrees: "/w",
      maxSeats: 4,
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: "/c",
          seats: [
            { id: "GUIDO-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
          ],
        },
      ],
    },
  } as unknown as CcConfig;

  it("overview has a numbers row for a seat, counting its runs", () => {
    store.upsertRun(
      run({
        id: "c1",
        agentId: "GUIDO-1",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    const o = overview(crewConfig, store, null, NOW);
    expect(o.agents.map((a) => a.agentId)).toEqual(["a1", "GUIDO-1"]);
    const seat = o.agents[1];
    expect(seat).toMatchObject({ runs24h: 1, ok14d: 1, session: null });
    expect(o.tokens24h).toBe(15);
  });

  it("activity shows a seat's run start and end", () => {
    store.upsertRun(run({ id: "c1", agentId: "GUIDO-1" }));
    const events = activity(crewConfig, store, NOW).filter((e) => e.who === "GUIDO-1");
    expect(events.map((e) => e.kind).sort()).toEqual(["run-end", "run-start"]);
  });

  it("activity: checks, commits, the test lock and guard denials", () => {
    store.upsertRun(run({ id: "c1", agentId: "GUIDO-1", ticket: "shop-app#7" }));
    store.addLoopEvent("k", "c1", "CI passed on abc1234", NOW - 500);
    store.addRunCommit({
      runId: "c1",
      repoId: "shop-app",
      branch: "b",
      sha: "a3f19c2deadbeef",
      at: NOW - 400,
    });
    store.addLockHold({
      runId: "c1",
      seatId: "GUIDO-1",
      toolUseId: "t",
      command: "pnpm -s test",
      since: NOW - 300,
      queuedAt: NOW - 300,
    });
    store.addGuardHit({
      agentId: "GUIDO-1",
      runId: "c1",
      rule: "git-write",
      text: "git push: use the mc push tool",
      at: NOW - 200,
    });
    const events = activity(crewConfig, store, NOW);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "check", text: "CI passed on abc1234", who: "GUIDO-1" }),
        expect.objectContaining({ kind: "commit", text: "Committed a3f19c2", ref: "shop-app#7" }),
        expect.objectContaining({ kind: "lock", text: "Took the test lock: pnpm -s test" }),
        expect.objectContaining({ kind: "guard", text: "Denied: git push: use the mc push tool" }),
      ]),
    );
    expect(events.some((e) => e.kind === "loop" && e.text.startsWith("CI passed"))).toBe(false);
  });
});
