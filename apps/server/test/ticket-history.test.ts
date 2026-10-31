import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { BoardItem, PullRequestView, Run, TicketHistory } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { sendComms } from "../src/comms.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 9, 30, 12);
const MIN = 60_000;
const BODY = [
  "## Outcome",
  "One read returns the ticket.",
  "",
  "## Done when",
  "- [x] The endpoint returns the fields",
  "- [ ] A ticket with no runs returns an empty timeline",
  "",
  "## Plan",
  "Not part of the outcome.",
].join("\n");

const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [],
  repos: [
    {
      id: "shop-app",
      github: "o/shop-app",
      project: 2,
      statusMap: { Todo: "planned" },
      autonomy: "draft",
    },
  ],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "shop-app",
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "In progress",
  state: "planned",
  labels: ["type:feature"],
  priority: "P1",
  updatedAt: NOW,
  url: `https://github.com/o/shop-app/issues/${n}`,
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "M",
  closed: false,
  prioritySource: null,
  createdAt: NOW,
  itemId: `I${n}`,
  projectId: "P1",
  ...over,
});

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido-1",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - 100 * MIN,
  endedAt: NOW - 90 * MIN,
  status: "ok",
  sessionId: null,
  model: "opus",
  branch: "feature/7-x",
  ticket: "shop-app#7",
  costUsd: 1.5,
  tokens: { input: 100, output: 50, cacheRead: 10, cacheCreate: 5 },
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});

const pr = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "shop-app",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/shop-app/pull/${number}`,
  branch: "feature/7-x",
  ticket: "shop-app#7",
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 80 * MIN,
  updatedAt: NOW - 10 * MIN,
  mergedAt: null,
  headSha: "sha2",
  mergeable: null,
  checks: [
    {
      name: "lint",
      kind: "check",
      state: "passing",
      conclusion: "success",
      attempt: 1,
      url: null,
      id: "c1",
    },
  ],
  ...over,
});

let dir: string;
let store: Store;
let app: FastifyInstance;
let issueBody: string | null;
let githubDown: boolean;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ticket-history-"));
  store = new Store(join(dir, "mc.sqlite"));
  issueBody = BODY;
  githubDown = false;
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    now: () => NOW,
    githubGql: async () => async () => {
      if (githubDown) throw new Error("GitHub is down");
      return {
        repository: {
          issue:
            issueBody === null
              ? null
              : {
                  number: 7,
                  title: "One read",
                  url: "https://github.com/o/shop-app/issues/7",
                  state: "OPEN",
                  body: issueBody,
                  labels: { nodes: [{ name: "type:feature" }] },
                  milestone: null,
                  subIssues: { nodes: [] },
                  closedByPullRequestsReferences: { nodes: [] },
                },
        },
      };
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const read = async (path: string) => app.inject({ method: "GET", url: path });

/** A reviewed round of PR 30: queued, run, reported with these findings. */
function review(round: number, sha: string, at: number, findings: number, resolved = false) {
  const id = store.requestReview({
    authorRunId: "dev-2",
    repoId: "shop-app",
    seatId: "retro-1",
    prNumber: 30,
    sha,
    epoch: 0,
    attempt: 1,
    round,
    at,
  });
  if (id === null) throw new Error("review not queued");
  store.setReviewState(id, ["queued"], "running", { runId: `rev-${round}`, at });
  store.recordFindings(id, `rev-${round}`, {
    verdict: { spec: findings === 0 ? "pass" : "fail", quality: "pass" },
    summary: `round ${round}`,
    findings: Array.from({ length: findings }, (_, k) => ({
      severity: "Important" as const,
      file: "a.ts",
      line: k + 1,
      summary: `finding ${k}`,
      scenario: "when it runs",
      fix: "change it",
    })),
    resolutions: resolved
      ? [{ findingRef: { reviewId: id - 1, pos: 0 }, outcome: "fixed" as const }]
      : [],
    at,
  });
  return id;
}

function seedFull() {
  store.replaceBoard("shop-app", [card(7)]);
  store.upsertRun(run("dev-1"));
  store.upsertRun(run("dev-2", { startedAt: NOW - 60 * MIN, endedAt: null, status: "running" }));
  store.upsertPullRequests("shop-app", [pr(30)], NOW);
  review(1, "sha1", NOW - 50 * MIN, 1);
  review(2, "sha2", NOW - 20 * MIN, 0, true);
  store.addFlightDecision({
    at: NOW - 30 * MIN,
    kind: "note",
    seatId: null,
    targetRunId: null,
    ref: "shop-app#7",
    questionId: null,
    about: "shop-app#7: rework",
    decision: "granted one more round",
    basis: "the finding was real",
  });
  store.addComms({
    at: NOW - 40 * MIN,
    from: "guido-1",
    to: "flight-1",
    ticket: "shop-app#7",
    text: "which header?",
    label: "question",
  });
}

describe("GET /api/tickets/:repoId/:number", () => {
  it("returns the fields, runs, PR with review rounds, CI, decision and comms, newest first", async () => {
    seedFull();
    const r = await read("/api/tickets/shop-app/7");
    expect(r.statusCode).toBe(200);
    const t = r.json() as TicketHistory;
    expect(t).toMatchObject({
      repoId: "shop-app",
      number: 7,
      url: "https://github.com/o/shop-app/issues/7",
      title: "One read",
      status: "In progress",
      priority: "P1",
      size: "M",
      labels: ["type:feature"],
      outcome: "One read returns the ticket.",
      doneWhen: [
        { text: "The endpoint returns the fields", checked: true },
        { text: "A ticket with no runs returns an empty timeline", checked: false },
      ],
      githubError: null,
      nextBefore: null,
    });
    expect(t.runs.map((x) => [x.id, x.seat, x.status])).toEqual([
      ["dev-2", "guido-1", "running"],
      ["dev-1", "guido-1", "ok"],
    ]);
    expect(t.runs[1]).toMatchObject({
      tokens: { input: 100, output: 50 },
      startedAt: NOW - 100 * MIN,
    });
    expect(t.prs).toHaveLength(1);
    const p = t.prs[0];
    expect(p?.rounds.map((x) => [x.round, x.findings.length])).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expect(p?.rounds[0]?.findings[0]).toMatchObject({
      summary: "finding 0",
      resolution: "fixed",
    });
    expect(p?.ci[0]).toMatchObject({
      sha: "sha2",
      checks: [{ name: "lint", conclusion: "success" }],
    });
    const kinds = t.timeline.map((e) => e.kind);
    expect(kinds.sort()).toEqual(["ci", "comms", "decision", "review", "review", "run", "run"]);
    const times = t.timeline.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(t.timeline.find((e) => e.kind === "decision")).toMatchObject({
      decision: "granted one more round",
    });
  });

  it("returns the fields and an empty timeline for a ticket with no runs", async () => {
    store.replaceBoard("shop-app", [card(7)]);
    const t = (await read("/api/tickets/shop-app/7")).json() as TicketHistory;
    expect(t).toMatchObject({
      number: 7,
      status: "In progress",
      runs: [],
      prs: [],
      timeline: [],
      nextBefore: null,
    });
    expect(t.doneWhen).toHaveLength(2);
  });

  it("still answers from the hub's own records when GitHub does not", async () => {
    store.replaceBoard("shop-app", [card(7)]);
    store.upsertRun(run("dev-1"));
    githubDown = true;
    const t = (await read("/api/tickets/shop-app/7")).json() as TicketHistory;
    expect(t).toMatchObject({
      title: "Ticket 7",
      body: null,
      outcome: null,
      doneWhen: [],
      githubError: "GitHub down".replace("GitHub down", "GitHub is down"),
    });
    expect(t.runs).toHaveLength(1);
  });

  it("answers 404 for an unknown repo, a bad number, and a ticket nothing knows", async () => {
    issueBody = null;
    expect((await read("/api/tickets/nope/7")).statusCode).toBe(404);
    expect((await read("/api/tickets/shop-app/0")).statusCode).toBe(404);
    expect((await read("/api/tickets/shop-app/abc")).statusCode).toBe(404);
    expect((await read("/api/tickets/shop-app/99")).statusCode).toBe(404);
  });

  it("rejects a bad limit or cursor", async () => {
    store.replaceBoard("shop-app", [card(7)]);
    expect((await read("/api/tickets/shop-app/7?limit=0")).statusCode).toBe(400);
    expect((await read("/api/tickets/shop-app/7?limit=201")).statusCode).toBe(400);
    expect((await read("/api/tickets/shop-app/7?before=junk")).statusCode).toBe(400);
  });

  it("pages 200 events with no overlap and keeps a full page under 60 KB gzipped", async () => {
    store.replaceBoard("shop-app", [card(7)]);
    const words =
      "the seat reads the ticket, plans, writes the failing test and then builds ".repeat(6);
    for (let k = 0; k < 100; k++)
      store.addComms({
        at: NOW - k * MIN,
        from: "guido-1",
        to: "flight-1",
        ticket: "shop-app#7",
        text: `${k}: ${words} ${Math.random().toString(36)}`,
        label: "handoff",
      });
    for (let k = 0; k < 100; k++)
      store.addFlightDecision({
        at: NOW - k * MIN - 30_000,
        kind: "note",
        seatId: null,
        targetRunId: null,
        ref: "shop-app#7",
        questionId: null,
        about: `shop-app#7: step ${k}`,
        decision: `${words} ${Math.random().toString(36)}`,
        basis: `${words} ${Math.random().toString(36)}`,
      });
    const full = await read("/api/tickets/shop-app/7?limit=200");
    const page = full.json() as TicketHistory;
    expect(page.timeline).toHaveLength(200);
    expect(page.nextBefore).toBeNull();
    expect(gzipSync(full.rawPayload).length).toBeLessThan(60_000);

    const keys: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const q: string =
        before === null ? "limit=50" : `limit=50&before=${encodeURIComponent(before)}`;
      const part = (await read(`/api/tickets/shop-app/7?${q}`)).json() as TicketHistory;
      keys.push(...part.timeline.map((e) => e.key));
      before = part.nextBefore;
      if (before === null) break;
    }
    expect(keys).toEqual(page.timeline.map((e) => e.key));
    expect(new Set(keys).size).toBe(200);
  });

  it("includes messages sent with the short ref a seat or the operator writes", async () => {
    store.replaceBoard("shop-app", [card(7)]);
    store.upsertPullRequests("shop-app", [pr(30)], NOW);
    const send = (text: string, ref: string) =>
      sendComms(
        {
          store,
          crew: () => ["guido-1", "flight-1"],
          knownSecrets: async () => [],
          now: () => NOW,
          seatSender: true,
        },
        "guido-1",
        { to: "flight-1", text, ref },
      );
    await send("about the ticket", "#7");
    await send("about the pr", "PR 30");
    await send("about another ticket", "#8");
    const t = (await read("/api/tickets/shop-app/7")).json() as TicketHistory;
    expect(t.timeline.flatMap((e) => (e.kind === "comms" ? [e.text] : [])).sort()).toEqual([
      "about the pr",
      "about the ticket",
    ]);
  });

  it("keeps a short-ref message from this repo's seat and drops one from another repo's when the hub serves several", async () => {
    const two = buildApp({
      config: {
        ...config,
        repos: [
          ...config.repos,
          { id: "other", github: "o/other", project: 3, statusMap: {}, autonomy: "draft" },
        ],
        // seatPlace reads only each session's repo and its seats' ids
        crew: {
          sessions: [
            { id: "s1", repoId: "shop-app", seats: [{ id: "guido-1" }] },
            { id: "s2", repoId: "other", seats: [{ id: "guido-9" }] },
          ],
        } as unknown as CcConfig["crew"],
      },
      store,
      bus: new ChangeBus(),
      now: () => NOW,
      githubGql: async () => async () => ({ repository: { issue: null } }),
    });
    await two.ready();
    store.replaceBoard("shop-app", [card(7)]);
    store.addComms({
      at: NOW,
      from: "guido-1",
      to: "flight-1",
      ticket: "#7",
      text: "mine",
      ref: "#7",
    });
    store.addComms({
      at: NOW,
      from: "guido-9",
      to: "flight-1",
      ticket: "#7",
      text: "theirs",
      ref: "#7",
    });
    store.addComms({
      at: NOW,
      from: "hub",
      to: "flight-1",
      ticket: "shop-app#7",
      text: "qualified",
    });
    const t = (
      await two.inject({ method: "GET", url: "/api/tickets/shop-app/7" })
    ).json() as TicketHistory;
    await two.close();
    expect(t.timeline.flatMap((e) => (e.kind === "comms" ? [e.text] : [])).sort()).toEqual([
      "mine",
      "qualified",
    ]);
  });

  it("looks the ticket up through indexes, never a table scan", () => {
    const plan = (sql: string, ...args: unknown[]) =>
      (
        store as unknown as {
          db: { prepare(s: string): { all(...a: unknown[]): { detail: string }[] } };
        }
      ).db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map((r) => r.detail)
        .join(" | ");
    for (const [sql, args] of [
      ["SELECT * FROM runs WHERE repo_id = ? AND ticket = ?", ["shop-app", "shop-app#7"]],
      ["SELECT * FROM pull_requests WHERE ticket = ? AND repo_id = ?", ["shop-app#7", "shop-app"]],
      ["SELECT * FROM reviews WHERE repo_id = ? AND pr_number = ?", ["shop-app", 30]],
      ["SELECT * FROM ci_runs WHERE repo_id = ? AND pr_number = ?", ["shop-app", 30]],
      [
        "SELECT * FROM comms WHERE ticket = ?1 OR ticket = ?2 OR ref = ?2 OR ref = ?1 OR ticket IN (?4) OR ref IN (?4) ORDER BY at DESC, id DESC LIMIT ?3",
        ["shop-app#7", "#7", 10, "PR 30"],
      ],
      ["SELECT * FROM flight_decisions WHERE ref = ?", ["shop-app#7"]],
    ] as const) {
      expect(plan(sql, ...args), sql).not.toMatch(/\bSCAN\b/);
    }
  });
});
