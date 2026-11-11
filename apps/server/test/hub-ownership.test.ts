/**
 * Two hubs on one repo. Hub A has runs; hub B has none. Every timer that could write to GitHub
 * runs on both against one fake GitHub, and B must make no write call while A still tidies, moves
 * cards and posts evidence for its own work. A closed PR alone starts no write on either.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  DEFAULT_REPO_RULES,
  type EvidenceManifest,
  NEW_LOOP,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { createBranchTidy } from "../src/branch-tidy.ts";
import { ChangeBus } from "../src/bus.ts";
import type { Gql } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import { createEngine, type EngineDeps } from "../src/engine/engine.ts";
import { externalReviewAsked } from "../src/external-pr-control.ts";
import { createExternalReviews, externalReviewKey } from "../src/external-reviews.ts";
import { clearBoardIds, moveCard } from "../src/github/board.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { createEvidenceSweep, postPrEvidence } from "../src/pr-evidence/sweep.ts";
import { createScheduler, realCollectors } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";
import { defined } from "./defined.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const HOUR = 60 * 60_000;
const SHA = (n: number) => String(n).padStart(40, "0");
const TOKEN = "fixture-operator-token";
const STATUS_MAP = {
  Todo: "planned",
  "In Progress": "in progress",
  "In Review": "review",
  Blocked: "blocked",
  Done: "done",
};
const OPTIONS = [
  { id: "O_todo", name: "Todo" },
  { id: "O_prog", name: "In Progress" },
  { id: "O_review", name: "In Review" },
  { id: "O_blocked", name: "Blocked" },
  { id: "O_done", name: "Done" },
];
const OPTION_OF: Record<string, string> = {
  Todo: "O_todo",
  "In Progress": "O_prog",
  "In Review": "O_review",
  Blocked: "O_blocked",
  Done: "O_done",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-own-"));
  clearBoardIds();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (): CcConfig =>
  ({
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    loops: [],
    repos: [
      {
        id: "mc",
        github: "octo-org/mc",
        project: 5,
        statusMap: STATUS_MAP,
        autonomy: "merge",
      },
    ],
    crew: {
      worktrees: dir,
      maxSeats: 2,
      sessions: [
        {
          id: "s",
          repoId: "mc",
          checkout: dir,
          seats: [{ id: "guido-1", role: "GUIDO", accountId: "a", model: "m", area: [] }],
        },
      ],
    },
    poll: { usageMinutes: 30, githubSeconds: 60 },
  }) as unknown as CcConfig;

const card = (issue: number, status: string, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "mc",
  issueNumber: issue,
  title: `t${issue}`,
  status,
  state: (STATUS_MAP as Record<string, BoardItem["state"]>)[status] ?? "planned",
  labels: [],
  assignees: [],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt: 1,
  itemId: null,
  projectId: null,
  ...over,
});

const pr = (number: number, branch: string, over: Partial<PullRequestView> = {}) =>
  ({
    repoId: "mc",
    number,
    title: `pr ${number}`,
    url: `https://github.com/octo-org/mc/pull/${number}`,
    branch,
    base: "main",
    ticket: null,
    closingIssues: [],
    state: "open",
    isDraft: false,
    review: null,
    ci: "passing",
    createdAt: NOW - 50 * HOUR,
    updatedAt: NOW - 24 * HOUR,
    mergedAt: null,
    headSha: SHA(number),
    mergeable: "MERGEABLE",
    changedFiles: 1,
    files: [{ path: "apps/web/src/board/Card.tsx", changeType: "MODIFIED" }],
    ...over,
  }) as PullRequestView;

const run = (id: string, branch: string, ticket: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 60 * HOUR,
  endedAt: null,
  status: "running",
  sessionId: "s",
  model: "m",
  branch,
  ticket,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  reviewId: null,
  ...over,
});

/** The PRs, branches and cards every hub sees on the repo; `branchAges` are hours since the tip commit. */
interface World {
  prs: PullRequestView[];
  cards: BoardItem[];
  branchAges: Record<string, number>;
}

const world = (): World => ({
  prs: [
    // hub A's live run, parked run and ended run
    pr(101, "feature/a-live", { ticket: "mc#1", closingIssues: [1] }),
    pr(102, "feature/a-parked", { ticket: "mc#2", closingIssues: [2] }),
    pr(103, "feature/a-ended", {
      ticket: "mc#3",
      closingIssues: [3],
      state: "merged",
      mergedAt: NOW - 30 * HOUR,
      headSha: "sha-feature/a-ended",
    }),
    // opened by hand: passing CI and a web file, no run on either hub
    pr(110, "feature/by-hand", { ticket: "mc#10", closingIssues: [10] }),
    // merged, its card still open, and no run on either hub
    pr(104, "feature/theirs-merged", {
      ticket: "mc#4",
      closingIssues: [4],
      state: "merged",
      mergedAt: NOW - 30 * HOUR,
      headSha: "sha-feature/theirs-merged",
    }),
    // closed, its card In review
    pr(105, "feature/theirs-closed", { ticket: "mc#5", closingIssues: [5], state: "closed" }),
  ],
  cards: [
    card(1, "In Progress"),
    card(2, "In Progress"),
    card(3, "In Review"),
    card(4, "In Review"),
    card(5, "In Review"),
    card(10, "Todo"),
    // a wait that has resolved: 7 is done
    card(6, "Blocked", { blockedBy: [], after: { issues: [7], prs: [] } } as Partial<BoardItem>),
    card(7, "Done", { closed: true }),
  ],
  branchAges: {
    "feature/a-live": 48,
    "feature/a-parked": 48,
    "feature/a-ended": 48,
    "feature/by-hand": 48,
    "feature/theirs-merged": 48,
    "feature/theirs-closed": 1,
    "feature/theirs-48": 48,
  },
});

function seedWorld(store: Store, w: World): void {
  store.replaceBoard("mc", w.cards);
  store.upsertPullRequests("mc", w.prs, NOW);
}

/** Hub A's runs: one live, one parked, one ended (its branch merged). */
function seedRuns(store: Store): void {
  store.upsertRun(run("live", "feature/a-live", "mc#1"));
  store.upsertRun(run("parked", "feature/a-parked", "mc#2", { status: "blocked" }));
  store.upsertRun(
    run("ended", "feature/a-ended", "mc#3", { status: "ok", endedAt: NOW - 30 * HOUR }),
  );
}

/** One fake GitHub for both hubs: reads answer, every write is logged. */
function fakeGithub(w: World, cardOption: Record<number, string>) {
  const writes: string[] = [];
  const reads: string[] = [];
  const comments: { body: string }[] = [];
  const statuses: unknown[] = [];
  const deleted: string[] = [];
  const bodies = new Map<number, string>();
  const WRITE_SUBCOMMANDS = new Set([
    "merge",
    "edit",
    "close",
    "reopen",
    "ready",
    "comment",
    "create",
    "delete",
    "rerun",
    "cancel",
  ]);
  const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const wire = (n: number) => {
    const p = w.prs.find((x) => x.number === n);
    if (!p) return null;
    return {
      number: n,
      state: p.state === "merged" ? "closed" : p.state,
      draft: false,
      title: p.title,
      body: bodies.get(n) ?? "Body.",
      html_url: p.url,
      labels: [],
      head: { sha: p.headSha, ref: p.branch, repo: { full_name: "octo-org/mc" } },
      base: { ref: "main", repo: { full_name: "octo-org/mc", default_branch: "main" } },
    };
  };
  const gh: GhRunner = async (args, options) => {
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    if (method !== "GET") writes.push(`${method} ${args.at(-3) ?? ""} ${args.join(" ")}`);
    else if (
      (args[0] === "pr" || args[0] === "issue" || args[0] === "run") &&
      args[1] &&
      WRITE_SUBCOMMANDS.has(args[1])
    )
      writes.push(args.join(" "));
    else reads.push(args.join(" "));
    if (args[0] === "api" && args[1] === "graphql") {
      const nodes = Object.entries(w.branchAges).map(([name, hours]) => ({
        name,
        target: {
          oid: w.prs.find((p) => p.branch === name)?.headSha ?? `sha-${name}`,
          committedDate: new Date(NOW - hours * HOUR).toISOString(),
        },
      }));
      return json({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            refs: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      });
    }
    if (args[0] === "pr" && args[1] === "list") {
      return json(
        w.prs
          .filter((p) => p.state === "open")
          .map((p) => ({ headRefName: p.branch, baseRefName: "main" })),
      );
    }
    if (method === "DELETE") {
      deleted.push(args.at(-1) ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (method === "PATCH") {
      const n = Number(/pulls\/(\d+)/.exec(args.join(" "))?.[1]);
      bodies.set(n, JSON.parse(options.input ?? "{}").body);
      return json({});
    }
    if (method === "POST") {
      const path = args[args.indexOf("POST") + 1] ?? "";
      const body = JSON.parse(options.input ?? "{}");
      if (path.endsWith("/comments")) comments.push(body);
      else statuses.push(body);
      return json({ id: 1 });
    }
    const path = args[1] ?? "";
    if (path.includes("/comments?")) return json([comments]);
    const m = /pulls\/(\d+)$/.exec(path);
    if (m) return json(wire(Number(m[1])));
    return json({});
  };
  const gqlCalls: string[] = [];
  const gql: Gql = async (query, vars) => {
    gqlCalls.push(query);
    if (query.includes("mutation")) {
      writes.push(`gql ${query.slice(0, 40)}`);
      const input = vars.input as { itemId: string; value: { singleSelectOptionId: string } };
      cardOption[Number(input.itemId.replace("I_", ""))] = input.value.singleSelectOptionId;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: input.itemId } } };
    }
    if (query.includes("projectItems")) {
      const n = Number(vars.number);
      return {
        repository: {
          issue: {
            projectItems: {
              nodes: [
                {
                  id: `I_${n}`,
                  project: { id: "PVT_5" },
                  status: cardOption[n] ? { optionId: cardOption[n] } : null,
                },
              ],
            },
          },
        },
      };
    }
    return {
      repositoryOwner: {
        __typename: "User",
        projectV2: {
          id: "PVT_5",
          fields: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: "F_title", name: "Title" },
              { id: "F_status", name: "Status", options: OPTIONS },
            ],
          },
        },
      },
    };
  };
  return { gh, gql, writes, reads, gqlCalls, comments, statuses, deleted, bodies };
}

/** A Proxy that records every call made through it and answers each with nothing. */
function recorder(calls: string[]): never {
  return new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args: unknown[]) => {
          calls.push(String(name));
          void args;
          return Promise.resolve(undefined);
        },
    },
  ) as never;
}

const manifest = (n: number, sha: string): EvidenceManifest => ({
  repoId: "mc",
  pr: n,
  sha,
  mainSha: "b".repeat(40),
  capturedAt: NOW,
  pairs: [],
});

/** Every timer that writes to GitHub on its own, run once on one hub. */
async function runEveryTimer(
  store: Store,
  w: World,
  gh: ReturnType<typeof fakeGithub>,
  cfg: CcConfig,
  publisherCalls: string[],
) {
  const bus = new ChangeBus();
  const collectors = {
    ...realCollectors(cfg),
    githubToken: async () => "tok",
    makeGql: () => gh.gql,
    github: async () => {
      await gh.gh(["api", "graphql"], { cwd: dir });
      return { boards: true, escalations: false };
    },
    prSweep: async () => ({ boards: true, escalations: false }),
    githubPrs: async () => ({ boards: false, escalations: false }),
  };
  const scheduler = createScheduler({
    config: cfg,
    store,
    bus,
    now: () => NOW,
    collectors: collectors as never,
  });
  await scheduler.tick("github");
  await scheduler.tick("prs");
  await scheduler.stop();

  const tidy = createBranchTidy({
    config: cfg,
    store,
    gh: gh.gh,
    dbPath: join(dir, "db.sqlite"),
    inClone: (_c, fn) => fn(),
    now: () => NOW,
    git: (async () => "") as never,
  });
  await tidy.sweep();
  await tidy.pruneLocal();

  const reviews = createExternalReviews({
    config: cfg,
    store,
    gh: gh.gh,
    cwd: dir,
    reviewer: () => "retro",
    textAllowed: async () => true,
    now: () => NOW,
    log: () => {},
  });
  const evidence = createEvidenceSweep({
    store,
    repoId: "mc",
    evidence: {
      baseUrl: "http://hub",
      ensure: async (t) => {
        await t.onStored?.(manifest(t.pr, t.sha));
      },
      gate: () => null,
      stop: async () => {},
    },
    post: (m) => postPrEvidence(gh.gh, dir, "octo-org/mc", m, "http://hub"),
    trusted: async () => true,
    log: () => {},
  });
  await evidence.tick();
  await reviews.sync();

  const engine = createEngine({
    config: cfg,
    store,
    bus,
    supervisor: new Proxy(
      {},
      {
        get: (_t, name) => {
          if (name === "on") return () => () => {};
          if (name === "busy") return () => false;
          if (name === "seat" || name === "seatFacts") return () => null;
          return async () => undefined;
        },
      },
    ) as never,
    publisher: recorder(publisherCalls),
    board: {
      move: (m) => moveCard({ gql: gh.gql, store, config: cfg, now: () => NOW }, m),
    },
    fetchTicket: async () => null,
    externalReviews: reviews,
    rules: async () => DEFAULT_REPO_RULES,
    refillQueues: async () => {},
    takeNext: async () => {},
    enabled: true,
    hubStartedAt: NOW,
    now: () => NOW,
  } satisfies EngineDeps);
  engine.start();
  await engine.tick();
  for (const r of store.loopRuns(0)) await engine.reconcileRun(r.id);
  engine.stop();
  void w;
}

describe("two hubs on one repo", () => {
  it("hub B with no runs writes nothing while hub A works", async () => {
    const w = world();
    const cfg = config();
    const cardsOf = () =>
      Object.fromEntries(w.cards.map((c) => [c.issueNumber, defined(OPTION_OF[c.status])]));
    const storeA = new Store(":memory:");
    const storeB = new Store(":memory:");
    seedWorld(storeA, w);
    seedWorld(storeB, w);
    seedRuns(storeA);

    const ghB = fakeGithub(w, cardsOf());
    const publisherB: string[] = [];
    await runEveryTimer(storeB, w, ghB, cfg, publisherB);
    expect(ghB.writes).toEqual([]);
    expect(publisherB).toEqual([]);
    expect(ghB.reads.length).toBeGreaterThan(0);
    expect(
      storeB
        .pullRequests("mc")
        .map((p) => p.number)
        .sort(),
    ).toEqual(w.prs.map((p) => p.number).sort());

    // hub A, on the same repo, does write for its own runs
    const ghA = fakeGithub(w, cardsOf());
    await runEveryTimer(storeA, w, ghA, cfg, []);
    expect(ghA.writes.length).toBeGreaterThan(0);
    storeA.close();
    storeB.close();
  });

  it("hub A tidies, moves cards and posts evidence for its own runs", async () => {
    const w = world();
    const cfg = config();
    const options = Object.fromEntries(
      w.cards.map((c) => [c.issueNumber, defined(OPTION_OF[c.status])]),
    );
    const store = new Store(":memory:");
    seedWorld(store, w);
    seedRuns(store);
    const gh = fakeGithub(w, options);
    await runEveryTimer(store, w, gh, cfg, []);

    // the ended run's 48-hour branch is deleted; the live, parked, hand-opened and foreign ones stay
    expect(gh.deleted.some((d) => d.endsWith("feature/a-ended"))).toBe(true);
    expect(gh.deleted.filter((d) => !d.endsWith("feature/a-ended"))).toEqual([]);
    // card follows: the parked run's open PR puts card 2 In review; the merged PR puts card 3 Done
    expect(options[2]).toBe("O_review");
    expect(options[3]).toBe("O_done");
    // nobody else's card moved
    expect([options[4], options[5], options[10], options[6]]).toEqual([
      "O_review",
      "O_review",
      "O_todo",
      "O_blocked",
    ]);
    // evidence on the run's PR, not on the hand-opened one
    expect(gh.bodies.get(101)).toContain("Screenshot evidence");
    expect(gh.bodies.has(110)).toBe(false);
    // no review is asked for yet
    expect(storeHasReview(store)).toBe(false);
    expect(gh.statuses).toEqual([]);

    // the operator asks: the hand-opened PR gets one queued review and an mc/review status
    const bus = new ChangeBus();
    const app = await buildApp({ config: cfg, store, bus, gh: gh.gh, operatorToken: TOKEN });
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/prs/mc/110/review-request",
        headers: { "x-mc-operator": TOKEN, "content-type": "application/json" },
        payload: JSON.stringify({ sha: SHA(110) }),
      });
      expect(r.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(externalReviewAsked(store, "mc", 110, SHA(110))).toBe(true);
    const reviews = createExternalReviews({
      config: cfg,
      store,
      gh: gh.gh,
      cwd: dir,
      reviewer: () => "retro",
      textAllowed: async () => true,
      now: () => NOW,
      log: () => {},
    });
    await reviews.sync();
    expect(store.reviewsOfRun(externalReviewKey("mc", 110))).toHaveLength(1);
    expect(gh.statuses).toHaveLength(1);
    store.close();
  });
});

const storeHasReview = (store: Store): boolean =>
  store.reviewsOfRun(externalReviewKey("mc", 110)).length > 0;

describe("a closed PR alone", () => {
  it.each(["hub A", "hub B"])("a closed PR alone starts no write on %s", async (hub) => {
    const cfg = config();
    const w: World = {
      prs: [
        pr(201, "feature/just-closed", { ticket: "mc#20", closingIssues: [20], state: "closed" }),
        pr(202, "feature/a-parked-closed", {
          ticket: "mc#21",
          closingIssues: [21],
          state: "closed",
        }),
        pr(203, "feature/a-watching", { ticket: "mc#22", closingIssues: [22], state: "closed" }),
      ],
      cards: [card(20, "In Review"), card(21, "In Progress"), card(22, "In Progress")],
      branchAges: { "feature/just-closed": 1, "feature/a-parked-closed": 48 },
    };
    const options = { 20: "O_review", 21: "O_prog", 22: "O_prog" } as Record<number, string>;
    const store = new Store(":memory:");
    seedWorld(store, w);
    if (hub === "hub A") {
      // its ended run owns the just-closed PR; a parked pr-closed run sits on the 48-hour branch
      store.upsertRun(
        run("ended", "feature/just-closed", "mc#20", { status: "ok", endedAt: NOW - 30 * 60_000 }),
      );
      store.upsertRun(run("parked", "feature/a-parked-closed", "mc#21", { status: "blocked" }));
      store.setRunLoop("parked", {
        ...NEW_LOOP,
        phase: "parked",
        parked: { kind: "pr-closed", reason: "closed", ended: false },
      } as never);
      // a live run whose open PR is then closed: the engine parks it and moves no card
      store.upsertRun(run("watching", "feature/a-watching", "mc#22"));
      store.setRunLoop("watching", {
        ...NEW_LOOP,
        phase: "ci",
        prNumber: 203,
        cardFor: "ci:0",
      } as never);
    }
    const gh = fakeGithub(w, options);
    await runEveryTimer(store, w, gh, cfg, []);
    expect(gh.writes).toEqual([]);
    expect(options).toEqual({ 20: "O_review", 21: "O_prog", 22: "O_prog" });
    expect(gh.deleted).toEqual([]);
    store.close();
  });
});

describe("a preview", () => {
  it("reads the preview path: main.ts hands the scheduler boardWrites off for a preview", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("boardWrites: !preview,");
    void vi;
  });
});
