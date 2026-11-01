import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMS_CAPCOM,
  NEW_LOOP,
  type PrUatView,
  type PullRequestView,
  type Run,
  UAT_PARK,
  uatSendBackText,
} from "@mc/core";
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

const pr = (repoId: string, number: number, branch = BRANCH): PullRequestView => ({
  repoId,
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/${repoId}/pull/${number}`,
  branch,
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

function review(
  round: number,
  sha: string,
  at: number,
  findings: number,
  prNumber = 30,
  outcome: "fixed" | "held" = "fixed",
  authorRunId = "dev-2",
  epoch = 0,
) {
  const id = store.requestReview({
    authorRunId,
    repoId: "shop-app",
    seatId: "retro-1",
    prNumber,
    sha,
    epoch,
    attempt: 1,
    round,
    at,
  });
  if (id === null) throw new Error("review not queued");
  store.setReviewState(id, ["queued"], "running", { runId: `rev-${id}`, at });
  store.recordFindings(id, `rev-${id}`, {
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
    resolutions: round === 2 ? [{ findingRef: { reviewId: id - 1, pos: 0 }, outcome }] : [],
    at,
  });
  return id;
}

const get = async (path: string) => app.inject({ method: "GET", url: path });

describe("GET /api/qa/uat/:repoId/:number", () => {
  it("serves only open PRs in the queue with UAT entry time bound to the current head", async () => {
    store.upsertPullRequests(
      "shop-app",
      [pr("shop-app", 70), { ...pr("shop-app", 71), state: "closed" }],
      NOW,
    );
    store.upsertRun(
      run("waiting", {
        endedAt: null,
        loop: {
          ...NEW_LOOP,
          epoch: 1,
          phase: "parked",
          prNumber: 70,
          parked: { kind: UAT_PARK, reason: "accept", ended: false },
          uat: { sha: "sha3", from: "review", accepted: false },
        },
      }),
    );
    store.addLoopEvent("waiting:1:parked:uat:sha3", "waiting", "waiting", NOW - 60000);
    const body = (await get("/api/qa/queue")).json();
    expect(body.prs.find((p: PullRequestView) => p.number === 70)?.uat).toEqual({
      sha: "sha3",
      since: NOW - 60000,
    });
    expect(body.prs.some((p: PullRequestView) => p.number === 71)).toBe(false);
    store.upsertPullRequests("shop-app", [{ ...pr("shop-app", 70), headSha: "new-head" }], NOW + 1);
    expect(
      (await get("/api/qa/queue")).json().prs.find((p: PullRequestView) => p.number === 70)?.uat,
    ).toBeUndefined();
  });

  it("serves the selected PR's exact changed files without requiring a cookie", async () => {
    store.upsertPullRequests(
      "shop-app",
      [
        {
          ...pr("shop-app", 30),
          files: [
            { path: "src/a.ts", changeType: "MODIFIED" },
            { path: "new/b.ts", changeType: "ADDED" },
          ],
        },
      ],
      NOW + 1,
    );
    const response = await get("/api/repos/shop-app/prs/30/files");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      repoId: "shop-app",
      number: 30,
      sha: "sha3",
      files: ["new/b.ts", "src/a.ts"],
    });
    expect((await get("/api/repos/unconfigured/prs/30/files")).statusCode).toBe(404);
    expect((await get(`/api/repos/shop-app/prs/${"9".repeat(100)}/files`)).statusCode).toBe(404);
  });
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

  it("keeps review chronology and reply/fix windows across a Send back epoch", async () => {
    review(1, "sha3", NOW - 10 * MIN, 0, 30, "fixed", "dev-2", 1);
    store.addComms({
      at: NOW - 8 * MIN,
      from: "dev-2",
      to: "retro-1",
      ticket: "shop-app#7",
      ref: "PR 30",
      text: "new cycle reply",
    });
    store.addRunCommit({
      runId: "dev-2",
      repoId: "shop-app",
      branch: BRANCH,
      sha: "newfix",
      at: NOW - 7 * MIN,
    });
    const body = (await get("/api/qa/uat/shop-app/30")).json() as PrUatView;
    expect(body.rounds.map((r) => [r.sequence, r.round, r.sha])).toEqual([
      [3, 1, "sha3"],
      [2, 2, "sha2"],
      [1, 1, "sha1"],
    ]);
    expect(body.rounds[0]?.reply?.text).toBe("new cycle reply");
    expect(body.rounds[0]?.fixSha).toBe("newfix");
    expect(body.rounds[1]?.reply).toBeNull();
    expect(body.rounds[1]?.fixSha).toBeNull();
    expect(body.rounds[2]?.reply?.text).toBe("fixed it");
  });

  it("builds the try-it commands from the run's branch name exactly", async () => {
    const body = (await get("/api/qa/uat/shop-app/30")).json() as PrUatView;
    expect(body.tryIt).toEqual({
      branch: BRANCH,
      commands: [`git fetch origin ${BRANCH} && git switch ${BRANCH}`, "pnpm dev"],
      previewUrl: null,
    });
  });

  it("keeps a round open when RETRO held its blocking finding", async () => {
    store.upsertPullRequests("shop-app", [pr("shop-app", 40)], NOW);
    store.upsertRun(run("dev-3"));
    review(1, "sha1", NOW - 50 * MIN, 1, 40, "fixed", "dev-3");
    review(2, "sha2", NOW - 20 * MIN, 1, 40, "held", "dev-3");
    const body = (await get("/api/qa/uat/shop-app/40")).json() as PrUatView;
    expect(body.rounds.map((r) => [r.round, r.result])).toEqual([
      [2, "open"],
      [1, "open"],
    ]);
  });

  it("quotes a branch name with shell characters and leaves tryIt.branch raw", async () => {
    const odd = "x;touch${IFS}/tmp/p";
    store.upsertPullRequests("shop-app", [pr("shop-app", 41, odd)], NOW);
    const body = (await get("/api/qa/uat/shop-app/41")).json() as PrUatView;
    expect(body.tryIt.branch).toBe(odd);
    expect(body.tryIt.commands[0]).toBe(`git fetch origin '${odd}' && git switch '${odd}'`);
  });

  it("says a PR is waiting for acceptance, since when, with the operator's last note", async () => {
    store.upsertPullRequests("shop-app", [pr("shop-app", 50)], NOW);
    store.upsertRun(
      run("dev-5", {
        endedAt: null,
        status: "running",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          prNumber: 50,
          epoch: 2,
          parked: { kind: UAT_PARK, reason: "waiting", ended: false },
          uat: { sha: "abc1234def", from: "ci", accepted: false },
        },
      }),
    );
    store.addLoopEvent("dev-5:2:parked:uat:abc1234def", "dev-5", "parked", NOW - 9 * MIN);
    store.addComms({
      at: NOW - 30 * MIN,
      from: COMMS_CAPCOM,
      to: "dev-2",
      ticket: "shop-app#7",
      targetRunId: "dev-5",
      text: uatSendBackText("0000000aaa", "the button is the wrong colour"),
    });
    store.addComms({
      at: NOW - 12 * MIN,
      from: COMMS_CAPCOM,
      to: "dev-2",
      ticket: "shop-app#7",
      targetRunId: "dev-5",
      text: uatSendBackText("1111111bbb", "still wrong on mobile"),
    });
    const body = (await get("/api/qa/uat/shop-app/50")).json() as PrUatView;
    expect(body.uat).toEqual({
      waiting: true,
      since: NOW - 9 * MIN,
      note: "still wrong on mobile",
    });
  });

  it("says a PR with no parked run is not waiting", async () => {
    const body = (await get("/api/qa/uat/shop-app/30")).json() as PrUatView;
    expect(body.uat).toEqual({ waiting: false, since: null, note: null });
  });

  it.each([
    [
      "parked for CI",
      { phase: "parked" as const, parked: { kind: "ci", reason: "r", ended: false } },
    ],
    ["still working", { phase: "working" as const, parked: null }],
  ])(
    "says a PR is not waiting while its run is %s, though loop.uat is not accepted",
    async (_, state) => {
      store.upsertPullRequests("shop-app", [pr("shop-app", 50)], NOW);
      store.upsertRun(
        run("dev-5", {
          endedAt: null,
          status: "running",
          loop: {
            ...NEW_LOOP,
            prNumber: 50,
            ...state,
            uat: { sha: "abc1234def", from: "ci", accepted: false },
          },
        }),
      );
      const body = (await get("/api/qa/uat/shop-app/50")).json() as PrUatView;
      expect(body.uat).toEqual({ waiting: false, since: null, note: null });
    },
  );

  it("carries the running preview's URL for its PR and null for another", async () => {
    store.upsertPullRequests("shop-app", [pr("shop-app", 41)], NOW);
    const withPreview = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      now: () => NOW,
      previewRepoId: "shop-app",
      previews: {
        get: (n: number) =>
          n === 30
            ? {
                pr: 30,
                sha: "sha3",
                branch: BRANCH,
                port: 7431,
                url: "http://127.0.0.1:7431",
                startedAt: NOW,
              }
            : null,
      } as never,
    });
    await withPreview.ready();
    const read = async (n: number) =>
      (
        (
          await withPreview.inject({ method: "GET", url: `/api/qa/uat/shop-app/${n}` })
        ).json() as PrUatView
      ).tryIt.previewUrl;
    const [started, other] = [await read(30), await read(41)];
    store.upsertPullRequests("shop-app", [{ ...pr("shop-app", 30), headSha: "new-head" }], NOW + 1);
    const stale = await read(30);
    await withPreview.close();
    expect(started).toBe("http://127.0.0.1:7431");
    expect(other).toBeNull();
    expect(stale).toBeNull();
  });

  it("checks out the exact displayed commit when the PR has an immutable head", async () => {
    const sha = "a".repeat(40);
    store.upsertPullRequests("shop-app", [{ ...pr("shop-app", 30), headSha: sha }], NOW + 1);
    const body = (await get("/api/qa/uat/shop-app/30")).json() as PrUatView;
    expect(body.tryIt.branch).toBe(BRANCH);
    expect(body.tryIt.commands[0]).toBe(`git fetch origin ${sha} && git switch --detach ${sha}`);
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
