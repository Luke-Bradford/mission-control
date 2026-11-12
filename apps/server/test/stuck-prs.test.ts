import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type BoardItem,
  COMMS_MC,
  FLIGHT_IDLE_MS,
  FLIGHT_STUCK_PR_MS,
  FLIGHT_WAITS_SETTING,
  freezeRules,
  NEW_LOOP,
  type PullRequestView,
  type RepoRules,
  type Run,
  type RunLoop,
  WAITING_OPERATOR_LABEL,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdItem } from "../src/attention/holds.ts";
import type { CcConfig } from "../src/config.ts";
import {
  ciLineText,
  conflictLineText,
  STUCK_PR_RETRY_MS,
  STUCK_PRS_SETTING,
  type StuckDeps,
  settleCleanConflict,
  stuckLineKey,
  stuckPrs,
  takeStuckPrs,
  trackStuckPrs,
  waitTargetNumber,
} from "../src/engine/stuck-prs.ts";
import { flightState } from "../src/flight/state.ts";
import { prFlow } from "../src/pr/flow.ts";
import { SupervisorError } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const run = promisify(execFile);

const T0 = Date.parse("2026-10-22T12:00:00Z");
const MIN = 60_000;
const REPO = "mc";
const GUIDO = "guido-1";
const INCO = "inco-1";
const ME = "me";

const RULES: RepoRules = freezeRules({
  pickFrom: ["Ready"],
  promoteBacklog: false,
  needs: ["done_when", "size"],
  areas: { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] },
  hardRules: [],
  hardRulesSet: true,
  hardRulesBy: "operator",
  alwaysAsk: [],
  uat: { labels: [], paths: [] },
  checks: [],
});

let dir: string;
let store: Store;
let config: CcConfig;
let now: number;
let started: { seatId: string; issue: number; loop: unknown }[];
let startError: Error | null;
let logs: string[];
let settleCalls: string[];

const makeConfig = (autonomy: "merge" | "draft" = "merge"): CcConfig =>
  ({
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
    repos: [{ id: REPO, github: "o/mc", project: 1, statusMap: {}, autonomy }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 8,
      sessions: [
        {
          id: "s1",
          repoId: REPO,
          checkout: join(dir, "clone"),
          seats: [
            { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
            {
              id: GUIDO,
              role: "GUIDO",
              accountId: "claude-main",
              model: "opus",
              area: ["apps/server/**"],
            },
            {
              id: INCO,
              role: "INCO",
              accountId: "claude-main",
              model: "opus",
              area: ["apps/web/**"],
            },
          ],
        },
      ],
    },
  }) as CcConfig;

const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: REPO,
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "In review",
  state: "planned",
  labels: ["area:server"],
  assignees: [],
  priority: null,
  updatedAt: T0,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "S",
  closed: false,
  prioritySource: null,
  createdAt: T0 - 1000 * n,
  itemId: `I${n}`,
  projectId: "P1",
  ...over,
});

const pr = (n: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: REPO,
  number: n,
  title: `PR ${n}`,
  url: "u",
  branch: `feature/${n}-x`,
  ticket: `${REPO}#${n}`,
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: T0 - 5 * 60 * MIN,
  updatedAt: T0 - 5 * 60 * MIN,
  mergedAt: null,
  headSha: `sha${n}`,
  mergeable: "CONFLICTING",
  author: ME,
  assignees: [],
  checks: [],
  ...over,
});

/** The ticket's author run, ended well before the PR was stuck for 30 minutes. */
const authorRun = (n: number, over: Partial<Run> = {}): Run => ({
  id: `${GUIDO}:${n}`,
  agentId: GUIDO,
  repoId: REPO,
  seq: n,
  startedAt: T0 - 5 * 60 * MIN,
  endedAt: T0 - 4 * 60 * MIN,
  status: "ok",
  sessionId: "s",
  model: "opus",
  branch: `feature/${n}-x`,
  ticket: `${REPO}#${n}`,
  ticketTitle: "x",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

/** A stuck PR 7 on ticket 7: conflicting, its author's run ended, the card in review. */
const stuckSetup = (
  n = 7,
  prOver: Partial<PullRequestView> = {},
  cardOver: Partial<BoardItem> = {},
) => {
  store.replaceBoard(REPO, [
    ...store.board(REPO).filter((c) => c.issueNumber !== n),
    card(n, cardOver),
  ]);
  store.upsertPullRequests(
    REPO,
    [...store.pullRequests(REPO).filter((p) => p.number !== n), pr(n, prOver)],
    T0,
  );
  store.upsertRun(authorRun(n));
};

const deps = (over: Partial<StuckDeps> = {}): StuckDeps => ({
  config,
  store,
  supervisor: {
    async startRun(seatId, issue, opts) {
      if (startError !== null) throw startError;
      started.push({ seatId, issue, loop: opts?.loop });
      store.setSeatSession({
        seatId,
        runId: `${seatId}:new`,
        cliSessionId: "cli",
        state: "running",
        reason: null,
        worktree: null,
        updatedAt: now,
      });
      return { runId: `${seatId}:new`, branch: "b" };
    },
  },
  login: ME,
  rules: async () => RULES,
  inClone: async (_checkout, fn) => {
    settleCalls.push("clone");
    return fn();
  },
  // a clone with no origin: the merge attempt answers "moved" without touching git
  git: async () => {
    throw new Error("no git here");
  },
  enabled: true,
  now: () => now,
  log: (l) => logs.push(l),
  ...over,
});

/** The hub has watched the stuck state for the 30 minutes. */
const stuckFor30 = () => {
  trackStuckPrs(store, config, now);
  now += FLIGHT_STUCK_PR_MS;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-stuck-"));
  store = new Store(join(dir, "mc.sqlite"));
  config = makeConfig();
  now = T0;
  started = [];
  startError = null;
  logs = [];
  settleCalls = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const list = () => stuckPrs({ store, config, repoId: REPO, flow: prFlow(store, REPO, now), now });
/** A hub merge attempt that finds the conflict real: the PR goes on to a seat. */
const realConflict = (): Partial<StuckDeps> => ({
  inClone: (async () => "conflict") as never,
});

describe("the stuck PR check", () => {
  it("lists a conflicting PR and a red-CI PR that have no run", () => {
    stuckSetup(7);
    stuckSetup(8, {
      mergeable: "MERGEABLE",
      ci: "failing",
      checks: [{ name: "lint", kind: "check", state: "failing", conclusion: "failure" }] as never,
    });
    expect(list().map((p) => [p.number, p.kind, p.failing])).toEqual([
      [7, "conflict", []],
      [8, "ci", ["lint"]],
    ]);
  });

  it("leaves out a PR that is mergeable with passing CI, a draft repo, and a PR the hub has no run on", () => {
    stuckSetup(7, { mergeable: "MERGEABLE", ci: "passing" });
    stuckSetup(8);
    store.upsertRun(authorRun(8, { branch: "feature/other" }));
    expect(list()).toEqual([]);
    stuckSetup(9);
    config = makeConfig("draft");
    expect(list()).toEqual([]);
  });

  it("is stuck after 30 minutes, counted from when the hub first saw it", () => {
    stuckSetup(7);
    trackStuckPrs(store, config, now);
    expect(JSON.parse(store.getSetting(STUCK_PRS_SETTING) ?? "{}")).toEqual({
      [`${REPO}#7:sha7:conflict`]: T0,
    });
    now = T0 + FLIGHT_STUCK_PR_MS - 1;
    expect(list()[0]?.since).toBe(T0);
    expect(now - (list()[0]?.since ?? 0)).toBeLessThan(FLIGHT_STUCK_PR_MS);
    // a new head starts the count again, and a PR that is fixed is forgotten
    store.upsertPullRequests(REPO, [pr(7, { headSha: "new" })], T0);
    trackStuckPrs(store, config, now);
    expect(Object.keys(JSON.parse(store.getSetting(STUCK_PRS_SETTING) ?? "{}"))).toEqual([
      `${REPO}#7:new:conflict`,
    ]);
    store.upsertPullRequests(REPO, [pr(7, { mergeable: "MERGEABLE" })], T0);
    trackStuckPrs(store, config, now);
    expect(store.getSetting(STUCK_PRS_SETTING)).toBeFalsy();
  });

  it("does not count a PR with a run working on it", () => {
    stuckSetup(7);
    store.upsertRun(authorRun(7, { endedAt: null, status: "running" }));
    expect(list()).toEqual([]);
  });
});

describe("a free seat takes a stuck PR", () => {
  it("starts the seat of the ticket's area on it, with the reason, and says so in Comms", async () => {
    stuckSetup(7);
    stuckFor30();
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([
      {
        seatId: GUIDO,
        issue: 7,
        loop: {
          ...NEW_LOOP,
          pendingLine: {
            key: stuckLineKey({ repoId: REPO, number: 7, headSha: "sha7" } as never),
            text: conflictLineText(7),
          },
        },
      },
    ]);
    expect(store.comms(0).filter((m) => m.from === COMMS_MC && m.to === GUIDO)).toMatchObject([
      { ticket: `${REPO}#7`, text: conflictLineText(7) },
    ]);
  });

  it("names the red checks for a red PR", async () => {
    stuckSetup(7, {
      mergeable: "MERGEABLE",
      ci: "failing",
      checks: [{ name: "lint", kind: "check", state: "failing", conclusion: "failure" }] as never,
    });
    stuckFor30();
    await takeStuckPrs(deps());
    const line = (started[0]?.loop as RunLoop | undefined)?.pendingLine;
    expect(line?.text).toBe(ciLineText(7, ["lint"]));
  });

  it("waits until the PR has stood 30 minutes", async () => {
    stuckSetup(7);
    trackStuckPrs(store, config, now);
    now += FLIGHT_STUCK_PR_MS - 1;
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([]);
  });

  it("goes before any Ready ticket: the seat it takes is no longer free for the queue", async () => {
    stuckSetup(7);
    stuckFor30();
    await takeStuckPrs(deps(realConflict()));
    const { seatMayTake } = await import("../src/engine/queue.ts");
    expect(seatMayTake(store, GUIDO)).toBe(false);
    expect(started.map((s) => s.seatId)).toEqual([GUIDO]);
  });

  it("leaves a PR whose area has no free seat for the next tick", async () => {
    stuckSetup(7, {}, { labels: ["area:web"] });
    store.setSeatSession({
      seatId: INCO,
      runId: "inco-1:1",
      cliSessionId: "cli",
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: now,
    });
    store.upsertRun(
      authorRun(99, {
        id: "inco-1:1",
        agentId: INCO,
        endedAt: null,
        branch: "b",
        ticket: `${REPO}#99`,
      }),
    );
    stuckFor30();
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([]);
  });

  it("does nothing when the engine is off or the hub's login is unknown", async () => {
    stuckSetup(7);
    stuckFor30();
    await takeStuckPrs(deps({ ...realConflict(), enabled: false }));
    await takeStuckPrs(deps({ ...realConflict(), login: null }));
    expect(started).toEqual([]);
  });

  it("tries a refused PR again after 10 minutes, not on every tick", async () => {
    stuckSetup(7);
    stuckFor30();
    startError = new SupervisorError(422, "nope");
    await takeStuckPrs(deps(realConflict()));
    await takeStuckPrs(deps(realConflict()));
    expect(logs.filter((l) => l.includes("could not take it"))).toHaveLength(1);
    startError = null;
    now += STUCK_PR_RETRY_MS;
    await takeStuckPrs(deps(realConflict()));
    expect(started).toHaveLength(1);
  });
});

describe("tickets and PRs that are never taken", () => {
  const cases: [string, () => void][] = [
    [
      "a ticket the operator set aside",
      () => stuckSetup(7, {}, { labels: ["area:server", WAITING_OPERATOR_LABEL] }),
    ],
    [
      "a parked ticket (a waste alarm)",
      () => {
        stuckSetup(7);
        store.waste.insertAlarm(
          {
            check: "retry-loop",
            subject: `${REPO}#7`,
            repoId: REPO,
            ticket: `${REPO}#7`,
            seatId: null,
            runId: null,
            level: 3,
            evidence: "x",
          } as never,
          T0,
        );
      },
    ],
    [
      "a ticket FLIGHT waits on",
      () => {
        stuckSetup(7);
        store.setSetting(
          FLIGHT_WAITS_SETTING,
          JSON.stringify({ [`${REPO}#7`]: { until: T0 + 24 * 60 * MIN, at: T0, reason: "r" } }),
        );
      },
    ],
    [
      "a PR FLIGHT waits on",
      () => {
        stuckSetup(7);
        store.setSetting(
          FLIGHT_WAITS_SETTING,
          JSON.stringify({ "PR 7": { until: T0 + 24 * 60 * MIN, at: T0, reason: "r" } }),
        );
      },
    ],
    [
      "a PR under a merge hold",
      () => {
        stuckSetup(7);
        store.upsertRun(authorRun(7));
        store.setRunLoop(`${GUIDO}:7`, {
          ...NEW_LOOP,
          mergeHold: { by: "FLIGHT", reason: "wait", at: T0, from: "ci" },
        } as never);
      },
    ],
    [
      "a PR the operator holds in Needs you",
      () => {
        stuckSetup(7);
        holdItem(store, `pr:${REPO}#7:123`, "later", { kind: "manual" }, "CAPCOM", T0);
      },
    ],
    [
      "a ticket held behind another PR",
      () => {
        stuckSetup(7);
        store.addHold({ ref: `${REPO}#7`, waitsOn: 3, basis: "b", at: T0 });
      },
    ],
    ["a closed card", () => stuckSetup(7, {}, { closed: true })],
  ];
  it.each(cases)("%s", async (_name, setup) => {
    setup();
    trackStuckPrs(store, config, now);
    now += FLIGHT_STUCK_PR_MS;
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([]);
    expect(list()).toEqual([]);
    const state = flightState({ config, store, busy: [], now, areas: RULES.areas });
    expect(state.signals.map((s) => s.kind)).not.toContain("stuck_pr");
  });
});

describe("a FLIGHT wait in any spelling of its target", () => {
  it("reads a target to its number", () => {
    expect(waitTargetNumber("mc", "PR#20")).toBe(20);
    expect(waitTargetNumber("mc", "mc#7")).toBe(7);
    expect(waitTargetNumber("mc", "other#7")).toBeNull();
    expect(waitTargetNumber("mc", "note:blocked:x")).toBeNull();
  });

  it.each([
    "7",
    "#7",
    "ticket 7",
    "issue 7",
    "20",
    "pr 20",
    "pull 20",
    "PR #20",
    "PR#20",
    "pull#20",
    "ticket#7",
    "issue#7",
    "mc#20",
    "mc#7",
  ])("holds PR 20 on ticket 7 when the wait is on %s", async (target) => {
    stuckSetup(7, { number: 20, branch: "feature/7-x", ticket: `${REPO}#7` });
    store.setSetting(
      FLIGHT_WAITS_SETTING,
      JSON.stringify({ [target]: { until: T0 + 24 * 60 * MIN, at: T0, reason: "r" } }),
    );
    trackStuckPrs(store, config, now);
    now += FLIGHT_STUCK_PR_MS;
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([]);
    expect(list()).toEqual([]);
  });

  it("does not hold on another repo's ref or an unrelated number", async () => {
    stuckSetup(7, { number: 20, branch: "feature/7-x", ticket: `${REPO}#7` });
    store.setSetting(
      FLIGHT_WAITS_SETTING,
      JSON.stringify({
        "other#7": { until: T0 + 24 * 60 * MIN, at: T0, reason: "r" },
        "21": { until: T0 + 24 * 60 * MIN, at: T0, reason: "r" },
      }),
    );
    trackStuckPrs(store, config, now);
    now += FLIGHT_STUCK_PR_MS;
    expect(list()).toHaveLength(1);
  });
});

describe("a freed seat is offered the stuck PR, and no other seat", () => {
  const second = () =>
    config.crew?.sessions[0]?.seats.push({
      id: "guido-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "opus",
      area: ["apps/server/**"],
    });

  it("starts only the seat it was called for", async () => {
    second();
    stuckSetup(7);
    stuckFor30();
    await takeStuckPrs(deps(realConflict()), "guido-2");
    expect(started.map((s) => [s.seatId, s.issue])).toEqual([["guido-2", 7]]);
  });

  it("starts nothing for a seat of another area, and sets no retry", async () => {
    stuckSetup(7);
    stuckFor30();
    await takeStuckPrs(deps(realConflict()), INCO);
    expect(started).toEqual([]);
    await takeStuckPrs(deps(realConflict()));
    expect(started.map((s) => s.seatId)).toEqual([GUIDO]);
  });
});

describe("the two-attempt rule (a call that stays FLIGHT's)", () => {
  const failReview = (round: number, sha: string) => {
    const id = store.requestReview({
      authorRunId: `${GUIDO}:7`,
      repoId: REPO,
      seatId: "retro",
      prNumber: 7,
      sha,
      epoch: 0,
      attempt: 1,
      round,
      at: T0,
    });
    if (id === null) throw new Error("no review");
    store.setReviewState(id, ["queued"], "running", { at: T0, runId: `rr${round}` });
    store.recordFindings(id, `rr${round}`, {
      verdict: { spec: "pass", quality: "fail" },
      summary: "s",
      findings: [
        { severity: "Important", file: "a.ts", line: 1, summary: "s", scenario: "w", fix: "f" },
      ],
      at: T0,
    });
  };
  const expired = [
    [
      "after its wait has expired",
      () =>
        store.setSetting(
          FLIGHT_WAITS_SETTING,
          JSON.stringify({ [`${REPO}#7`]: { until: T0 - 1, at: T0 - 60 * MIN, reason: "r" } }),
        ),
    ],
    ["with no wait at all", () => {}],
  ] as const;

  it.each(expired)("a PR that failed two reviews is not offered %s", async (_n, wait) => {
    stuckSetup(7);
    failReview(1, "sha-a");
    failReview(2, "sha-b");
    wait();
    stuckFor30();
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([]);
    expect(list()).toEqual([]);
    const state = flightState({ config, store, busy: [], now, areas: RULES.areas });
    expect(state.signals.map((s) => s.kind)).not.toContain("stuck_pr");
  });

  it("a PR that failed one review is still offered", async () => {
    stuckSetup(7);
    failReview(1, "sha-a");
    stuckFor30();
    await takeStuckPrs(deps(realConflict()));
    expect(started).toHaveLength(1);
  });

  it("a ticket whose run FLIGHT ended is not offered, even after its wait expires", async () => {
    stuckSetup(7);
    store.addFlightDecision({
      at: T0 - 60 * MIN,
      kind: "end",
      seatId: "flight-1",
      targetRunId: `${GUIDO}:7`,
      ref: `${REPO}#7`,
      questionId: null,
      about: `${REPO}#7`,
      decision: "Ended the run",
      basis: "two attempts",
    });
    stuckFor30();
    await takeStuckPrs(deps(realConflict()));
    expect(started).toEqual([]);
    expect(list()).toEqual([]);
  });
});

describe("FLIGHT hears only when no seat can take it", () => {
  const signals = (areas = RULES.areas) =>
    flightState({ config, store, busy: [], now, areas }).signals.filter(
      (s) => s.kind === "stuck_pr",
    );

  it("raises one fact for a PR whose area no seat covers, once", () => {
    stuckSetup(7, {}, { labels: ["area:docs"] });
    stuckFor30();
    const areas = { ...RULES.areas, "area:docs": ["docs/**"] };
    expect(signals(areas)).toHaveLength(1);
    expect(signals(areas)[0]?.key).toBe(`${REPO}#7:7:sha7:conflict`);
    expect(signals(areas)).toHaveLength(1);
  });

  it("raises nothing before the 30 minutes", () => {
    stuckSetup(7, {}, { labels: ["area:docs"] });
    trackStuckPrs(store, config, now);
    now += FLIGHT_STUCK_PR_MS - 1;
    expect(signals({ ...RULES.areas, "area:docs": ["docs/**"] })).toEqual([]);
  });

  it("says nothing while a seat covers the area: placing it is the hub's", () => {
    stuckSetup(7);
    stuckFor30();
    expect(signals()).toEqual([]);
  });
});

describe("an idle seat next to an unowned stuck PR", () => {
  const idle = () => {
    store.setSeatSession({
      seatId: GUIDO,
      runId: null,
      cliSessionId: "cli",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: T0,
    });
  };
  const idleSeat = () =>
    flightState({ config, store, busy: [], now, areas: RULES.areas }).signals.filter(
      (s) => s.kind === "idle_seat",
    );

  it("counts as queued work for the idle_seat fact", () => {
    idle();
    stuckSetup(7);
    stuckFor30();
    now += FLIGHT_IDLE_MS;
    const found = idleSeat();
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("PR #7");
  });

  it("does not when the PR is in another seat's area, or not yet stuck", () => {
    idle();
    stuckSetup(7, {}, { labels: ["area:web"] });
    stuckFor30();
    now += FLIGHT_IDLE_MS;
    expect(idleSeat()).toEqual([]);
    stuckSetup(8);
    trackStuckPrs(store, config, now);
    expect(idleSeat()).toEqual([]);
  });
});

describe("a conflict that merges cleanly", () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  let origin: string;
  let clone: string;

  const realGit: StuckDeps["git"] = async (cwd, args, _common, o) =>
    (
      await run("git", args, {
        cwd,
        env: { ...process.env, ...(o?.env ?? {}) },
      })
    ).stdout;

  /** main and a branch that both changed `a.txt`, on the line `branchLine` / `mainLine` of it. */
  const diverge = (branchLine: number, mainLine: number) => {
    origin = join(dir, "origin.git");
    clone = join(dir, "clone");
    mkdirSync(origin);
    sh(origin, "init", "--bare", "--initial-branch=main");
    mkdirSync(clone);
    sh(clone, "init", "--initial-branch=main");
    sh(clone, "remote", "add", "origin", origin);
    writeFileSync(join(clone, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    sh(clone, "add", ".");
    sh(clone, "commit", "-m", "base");
    sh(clone, "push", "origin", "main");
    sh(clone, "checkout", "-b", "feature/7-x");
    const edit = (line: number, text: string) => {
      const lines = "1\n2\n3\n4\n5\n6\n7\n8\n9\n".split("\n");
      lines[line - 1] = text;
      writeFileSync(join(clone, "a.txt"), lines.join("\n"));
    };
    edit(branchLine, "branch");
    sh(clone, "commit", "-am", "branch change");
    sh(clone, "push", "origin", "feature/7-x");
    const head = sh(clone, "rev-parse", "HEAD");
    sh(clone, "checkout", "main");
    edit(mainLine, "main");
    sh(clone, "commit", "-am", "main change");
    sh(clone, "push", "origin", "main");
    return head;
  };

  it("is merged by the hub and pushed, with no run started", async () => {
    const head = diverge(1, 9);
    stuckSetup(7, { headSha: head });
    stuckFor30();
    await takeStuckPrs(deps({ git: realGit }));
    expect(started).toEqual([]);
    const tip = sh(origin, "rev-parse", "refs/heads/feature/7-x");
    expect(tip).not.toBe(head);
    expect(sh(origin, "log", "-1", "--format=%an|%s|%P", tip).split("|")).toEqual([
      "Mission Control",
      "Merge main into feature/7-x",
      `${head} ${sh(origin, "rev-parse", "refs/heads/main")}`,
    ]);
    expect(logs.join("\n")).toContain("merged main into feature/7-x");
  });

  it("is left alone when it is a real conflict: nothing is pushed and a seat takes it", async () => {
    const head = diverge(5, 5);
    stuckSetup(7, { headSha: head });
    stuckFor30();
    await takeStuckPrs(deps({ git: realGit }));
    expect(sh(origin, "rev-parse", "refs/heads/feature/7-x")).toBe(head);
    expect(started.map((s) => s.seatId)).toEqual([GUIDO]);
  });

  it("does not push when the branch moved since the poll", async () => {
    const head = diverge(1, 9);
    stuckSetup(7, { headSha: "0".repeat(40) });
    const result = await settleCleanConflict(
      { config, inClone: async (_c, fn) => fn(), git: realGit },
      { repoId: REPO, branch: "feature/7-x", headSha: "0".repeat(40) },
    );
    expect(result).toBe("moved");
    expect(sh(origin, "rev-parse", "refs/heads/feature/7-x")).toBe(head);
  });
});
