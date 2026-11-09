import {
  CONTROLLER_HEADER,
  NEW_LOOP,
  OPERATOR_HEADER,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import type { Supervisor } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const SHA = "a".repeat(40),
  NEXT = "b".repeat(40),
  NOW = 1000;
let store: Store;
let app: ReturnType<typeof buildApp>;
let noWrites: boolean;
let current: ReturnType<typeof wire>;
let duringRead: (() => void) | undefined;
let ghFailure: boolean;
let accepted: boolean;
let seatToken: string;
const adopt = vi.fn();
const credentials: Record<string, string>[] = [
  { [CONTROLLER_HEADER]: "controller" },
  { [OPERATOR_HEADER]: "operator" },
];
const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "account", vendor: "claude", alertAt: 85, stopAt: 92 }],
  repos: [
    {
      id: "mc",
      github: "example/mc",
      project: 1,
      statusMap: {},
      autonomy: "merge",
      flightPowers: "superuser",
    },
  ],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/adoption-worktrees",
    maxSeats: 1,
    sessions: [
      {
        id: "crew",
        repoId: "mc",
        checkout: "/tmp/adoption-checkout",
        seats: [{ id: "guido-1", role: "GUIDO", accountId: "account", model: "fixture", area: [] }],
      },
    ],
  },
};
const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number: 12,
  title: "Preserved PR",
  url: "https://github.com/example/mc/pull/12",
  branch: "feature/preserved",
  base: "main",
  ticket: "mc#7",
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  headSha: NEXT,
  mergeable: "MERGEABLE",
  ...over,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: "author",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW,
  endedAt: null,
  status: "running",
  sessionId: "fixture",
  model: "fixture",
  branch: "feature/preserved",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/fixture",
  prs: [],
  summary: null,
  loop: {
    ...NEW_LOOP,
    phase: "working",
    prNumber: 12,
    aside: { worktree: "/tmp/preserved", wake: false },
  },
  ...over,
});
function wire() {
  return {
    number: 12,
    state: "open",
    draft: false,
    title: "Preserved PR",
    body: "Closes #7",
    labels: [],
    head: { sha: NEXT, ref: "feature/preserved", repo: { full_name: "example/mc" } },
    base: { ref: "main", repo: { full_name: "example/mc", default_branch: "main" } },
  };
}
const post = (
  headers: Record<string, string> = { [CONTROLLER_HEADER]: "controller" },
  payload: object = { sha: NEXT },
) => app.inject({ method: "POST", url: "/api/runs/author/pr-head", headers, payload });

beforeEach(async () => {
  store = new Store(":memory:");
  noWrites = false;
  current = wire();
  duringRead = undefined;
  ghFailure = false;
  accepted = true;
  adopt.mockReset();
  store.upsertRun(run());
  store.upsertPullRequests("mc", [pr()], NOW);
  store.setRunPush({ runId: "author", sha: SHA, at: NOW });
  const gh: GhRunner = async () => {
    if (ghFailure) throw new Error("private upstream detail");
    duringRead?.();
    return { code: 0, stdout: JSON.stringify(current), stderr: "" };
  };
  const tokens = new RunTokens();
  seatToken = tokens.issue("guido-1", "author");
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    now: () => NOW,
    gh,
    tokens,
    operatorToken: "operator",
    controllerToken: "controller",
    get noLoopWrites() {
      return noWrites;
    },
    supervisor: { status: () => ({ enabled: true, note: null }) } as unknown as Supervisor,
    engine: {
      status: () => ({ on: true, note: null }),
      onOperatorMessage: async () => ({ lifted: false, reason: "held" }),
      adoptPrHead: async (...args) => {
        adopt(...args);
        if (!accepted) return false;
        store.setRunPush({ runId: "author", sha: NEXT, at: NOW });
        const saved = store.run("author");
        if (saved?.loop) store.setRunLoop(saved.id, { ...saved.loop, adopted: true });
        return true;
      },
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  store.close();
});

describe("controller recovery of a preserved crew PR", () => {
  it.each(credentials)(
    "verifies the published source and delegates once with %j",
    async (headers) => {
      expect((await post(headers)).statusCode).toBe(200);
      expect(adopt.mock.calls).toEqual([["author", NEXT, "Controller"]]);
      expect(store.flightDecisions(0, 10)).toContainEqual(
        expect.objectContaining({ kind: "sync", targetRunId: "author" }),
      );
      expect((await post(headers)).statusCode).toBe(200);
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(store.qaCheckReceipts("author", NEXT)).toEqual([]);
    },
  );
  it("requires an independent operator credential", async () => {
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ [OPERATOR_HEADER]: "wrong" })).statusCode).toBe(401);
    expect(
      (await post({ [OPERATOR_HEADER]: "operator", "x-mc-flight-actor": "untrusted" })).statusCode,
    ).toBe(403);
    expect(
      (await post({ [OPERATOR_HEADER]: "operator", authorization: `Bearer ${seatToken}` }))
        .statusCode,
    ).toBe(403);
    expect(adopt).not.toHaveBeenCalled();
  });
  it("rejects malformed and stale heads before adoption", async () => {
    expect((await post(undefined, { sha: "bbbbbbb" })).statusCode).toBe(400);
    expect((await post(undefined, { sha: SHA })).statusCode).toBe(409);
    expect(adopt).not.toHaveBeenCalled();
  });
  it("keeps the existing unknown-run response", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/runs/missing/pr-head",
      headers: { [CONTROLLER_HEADER]: "controller" },
      payload: { sha: NEXT },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "unknown run" });
    expect(adopt).not.toHaveBeenCalled();
  });
  it.each(["foreign", "moved", "draft", "branch"])("rejects %s GitHub provenance", async (kind) => {
    if (kind === "foreign") current.head.repo.full_name = "someone/else";
    if (kind === "moved") current.head.sha = SHA;
    if (kind === "draft") current.draft = true;
    if (kind === "branch") current.head.ref = "another-branch";
    expect((await post()).statusCode).toBe(409);
    expect(adopt).not.toHaveBeenCalled();
  });
  it("rechecks a head that moves during the GitHub read", async () => {
    duringRead = () => store.upsertPullRequests("mc", [pr({ headSha: SHA })], NOW + 1);
    expect((await post()).statusCode).toBe(409);
    expect(adopt).not.toHaveBeenCalled();
  });
  it("refuses previews without changing the run", async () => {
    noWrites = true;
    expect((await post()).statusCode).toBe(409);
    expect(store.runPush("author")?.sha).toBe(SHA);
    expect(adopt).not.toHaveBeenCalled();
  });
  it("keeps a held or active run held and logs no success", async () => {
    accepted = false;
    expect((await post()).statusCode).toBe(409);
    expect(store.flightDecisions(0, 10)).toEqual([]);
  });
  it("keeps upstream failure details private", async () => {
    ghFailure = true;
    const response = await post();
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("private upstream detail");
    expect(adopt).not.toHaveBeenCalled();
  });
});
