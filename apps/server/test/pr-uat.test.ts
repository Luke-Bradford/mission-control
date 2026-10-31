import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrUatView, PullRequestView, Run } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 9, 30, 12);
const MIN = 60_000;
const BRANCH = "feature/7-odd_name.v2";

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
      runCommand: "pnpm dev",
    },
  ],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId: "dev-2",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - 100 * MIN,
  endedAt: NOW - 1 * MIN,
  status: "ok",
  sessionId: null,
  model: "opus",
  branch: BRANCH,
  ticket: "shop-app#7",
  costUsd: 1,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 },
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});

const pr = (repoId: string, number: number): PullRequestView => ({
  repoId,
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/${repoId}/pull/${number}`,
  branch: BRANCH,
  ticket: `${repoId}#7`,
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 80 * MIN,
  updatedAt: NOW - 10 * MIN,
  mergedAt: null,
  headSha: "sha3",
  mergeable: null,
  checks: [],
});

let dir: string;
let store: Store;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pr-uat-"));
  store = new Store(join(dir, "mc.sqlite"));
  app = buildApp({ config, store, bus: new ChangeBus(), now: () => NOW });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function review(round: number, sha: string, at: number, findings: number) {
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
    resolutions:
      round === 2 ? [{ findingRef: { reviewId: id - 1, pos: 0 }, outcome: "fixed" as const }] : [],
    at,
  });
  return id;
}

const get = async (path: string) => app.inject({ method: "GET", url: path });

describe("GET /api/qa/uat/:repoId/:number", () => {
  beforeEach(() => {
    store.upsertRun(run("dev-2"));
    store.upsertPullRequests("shop-app", [pr("shop-app", 30)], NOW);
    review(1, "sha1", NOW - 50 * MIN, 2);
    review(2, "sha2", NOW - 20 * MIN, 0);
    store.addRunCommit({
      runId: "dev-2",
      repoId: "shop-app",
      branch: BRANCH,
      sha: "fix1234",
      at: NOW - 40 * MIN,
    });
    store.addComms({
      at: NOW - 45 * MIN,
      from: "retro-1",
      to: "dev-2",
      ticket: null,
      text: "one",
      ref: "PR 30",
    });
    store.addComms({
      at: NOW - 44 * MIN,
      from: "dev-2",
      to: "retro-1",
      ticket: null,
      text: "fixed it",
      ref: "PR 30",
    });
    store.addComms({
      at: NOW - 5 * MIN,
      from: "flight-1",
      to: "dev-2",
      ticket: "shop-app#7",
      text: "three",
    });
  });

  it("returns both rounds and all three messages, newest first", async () => {
    const res = await get("/api/qa/uat/shop-app/30");
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrUatView;
    expect(body.comms.map((m) => m.text)).toEqual(["three", "fixed it", "one"]);
    expect(body.comms[0]).toMatchObject({ from: "flight-1", at: NOW - 5 * MIN });
    expect(body.rounds.map((r) => r.round)).toEqual([2, 1]);
    const first = body.rounds[1];
    expect(first?.blocking.map((f) => f.line)).toEqual([1, 2]);
    expect(first?.blocking[0]?.summary).toBe("a.ts:1 finding 0");
    expect(first?.reply).toMatchObject({ from: "dev-2", text: "fixed it" });
    expect(first?.fixSha).toBe("fix1234");
    expect(body.rounds[0]?.blocking).toEqual([]);
    expect(body.rounds[0]?.result).toBe("clean");
    expect(first?.result).toBe("resolved");
  });

  it("builds the try-it commands from the run's branch name exactly", async () => {
    const body = (await get("/api/qa/uat/shop-app/30")).json() as PrUatView;
    expect(body.tryIt).toEqual({
      branch: BRANCH,
      commands: [`git fetch origin ${BRANCH} && git switch ${BRANCH}`, "pnpm dev"],
      previewUrl: null,
    });
  });

  it("omits the run command when the repo has none", async () => {
    const bare = buildApp({
      config: { ...config, repos: [{ ...config.repos[0], runCommand: undefined } as never] },
      store,
      bus: new ChangeBus(),
      now: () => NOW,
    });
    await bare.ready();
    const res = await bare.inject({ method: "GET", url: "/api/qa/uat/shop-app/30" });
    await bare.close();
    expect((res.json() as PrUatView).tryIt.commands).toEqual([
      `git fetch origin ${BRANCH} && git switch ${BRANCH}`,
    ]);
  });

  it("answers 404 for an unknown repo or PR", async () => {
    expect((await get("/api/qa/uat/nope/30")).statusCode).toBe(404);
    expect((await get("/api/qa/uat/shop-app/99")).statusCode).toBe(404);
    expect((await get("/api/qa/uat/shop-app/x")).statusCode).toBe(404);
  });
});
