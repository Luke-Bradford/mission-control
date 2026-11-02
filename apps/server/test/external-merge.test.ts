import { Buffer } from "node:buffer";
import { DEFAULT_REPO_RULES, type PullRequestView, type TicketView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import {
  externalPrControl,
  setExternalMergeHold,
  setExternalPrControl,
} from "../src/external-pr-control.ts";
import { externalReviewKey } from "../src/external-reviews.ts";
import { mergeExternalPr } from "../src/flight/external-merge.ts";
import { operatorCall } from "../src/flight/operator-call.ts";
import { grantApproval, mergeFloorScope } from "../src/flight-approvals.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { prAcceptanceFor, prUat } from "../src/pr-uat.ts";
import { reviewCheckFor } from "../src/review-check.ts";
import { Store } from "../src/store.ts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const TOKEN = "fixture-operator-token";
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "merge" }],
  crew: {
    worktrees: "/fixture/worktrees",
    sessions: [
      {
        id: "sample",
        repoId: "sample",
        checkout: "/fixture/clone",
        seats: [{ id: "flight", role: "FLIGHT", accountId: "account", model: "opus", area: [] }],
      },
    ],
  },
};
const pr: PullRequestView = {
  repoId: "sample",
  number: 7,
  title: "Sample change",
  url: "https://github.com/example/sample/pull/7",
  branch: "controller/change",
  base: "main",
  ticket: null,
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: 1,
  updatedAt: 1,
  mergedAt: null,
  headSha: SHA,
  mergeable: "MERGEABLE",
};
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
  store.upsertPullRequests("sample", [pr], 1);
  const id = store.requestReview({
    authorRunId: externalReviewKey("sample", 7),
    repoId: "sample",
    seatId: "retro",
    prNumber: 7,
    sha: SHA,
    epoch: 0,
    attempt: 1,
    round: 1,
    at: 1,
  });
  if (id === null) throw new Error("review fixture missing");
  store.setReviewState(id, ["queued"], "running", { at: 2, runId: "retro:review" });
  store.recordFindings(id, "retro:review", {
    verdict: { spec: "pass", quality: "pass" },
    summary: "Checked.",
    findings: [],
    at: 3,
  });
});
afterEach(() => store.close());

function harness() {
  const bus = new ChangeBus();
  const wire = {
    number: 7,
    state: "open",
    draft: false,
    title: "Sample change",
    body: "Sample change.",
    labels: [] as { name: string }[],
    head: { sha: SHA, ref: pr.branch, repo: { full_name: "example/sample" } },
    base: { ref: "main", repo: { full_name: "example/sample", default_branch: "main" } },
  };
  const facts = {
    headRefOid: SHA,
    baseRefOid: BASE,
    changedFiles: 1,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    closingIssuesReferences: [] as { number: number; url: string }[],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "mc/review", state: "SUCCESS" },
    ],
  };
  const state = {
    files: [{ filename: "src/example.ts", status: "modified" }],
    rules: {
      ...DEFAULT_REPO_RULES,
      hardRules: [] as string[],
      hardRulesSet: true,
      hardRulesBy: "controller" as const,
      uat: { labels: [] as string[], paths: [] as string[] },
    },
    clock: 100,
    ruleReads: 0,
    expireOnFinalRead: false,
    moveDuringFiles: false,
  };
  const merges: string[][] = [];
  let merged = false;
  const gh: GhRunner = async (args) => {
    let value: unknown;
    if (args[0] === "pr" && args[1] === "merge") {
      merges.push(args);
      merged = true;
      value = {};
    } else if (args.includes("--json=state,headRefOid"))
      value = { state: merged ? "MERGED" : "OPEN", headRefOid: SHA };
    else if (args[0] === "pr") value = facts;
    else if (args[1]?.includes("/files?")) {
      value = [state.files];
      if (state.moveDuringFiles) wire.head.sha = BASE;
    } else if (args[1]?.includes("/contents/CLAUDE.md"))
      value = {
        encoding: "base64",
        content: Buffer.from(
          "# Guidance\n## Mission Control\n```yaml\nmc:\n  needs: [size]\n```\n",
        ).toString("base64"),
      };
    else value = wire;
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  const deps = {
    config,
    repo: config.repos[0]!,
    store,
    bus,
    gh,
    cwd: "/fixture",
    number: 7,
    now: () => state.clock,
    rules: async () => {
      if (++state.ruleReads > 1 && state.expireOnFinalRead) state.clock = 200;
      return state.rules;
    },
    fetchTicket: async (): Promise<TicketView | null> => null,
  };
  return { wire, facts, state, deps, merges };
}

describe("external PR controller merge", () => {
  it("merges a clean exact head without an author run and uses GitHub's atomic head check", async () => {
    const h = harness();
    expect((await mergeExternalPr(h.deps)).isError).toBeUndefined();
    expect(h.merges).toEqual([
      ["pr", "merge", "7", "--repo=example/sample", "--merge", `--match-head-commit=${SHA}`],
    ]);
    expect(store.run(externalReviewKey("sample", 7))).toBeNull();
  });

  it("respects a real external mc/review sign-off without inventing a scratch report", async () => {
    store.close();
    store = new Store(":memory:");
    store.upsertPullRequests("sample", [pr], 1);
    const h = harness();
    expect((await mergeExternalPr(h.deps)).isError).toBeUndefined();
    expect(store.reviewsOfPr("sample", 7)).toHaveLength(0);
    expect(store.run(externalReviewKey("sample", 7))).toBeNull();
  });

  it.each(["ci", "review", "head", "files", "hold", "fork"])(
    "refuses missing or changed merge evidence: %s",
    async (failure) => {
      const h = harness();
      if (failure === "ci") h.facts.statusCheckRollup[0]!.conclusion = "FAILURE";
      if (failure === "review") {
        const id = store.reviewsOfPr("sample", 7)[0]!.id;
        store.setReviewState(id, ["reported"], "superseded", { at: 4 });
      }
      if (failure === "head") h.state.moveDuringFiles = true;
      if (failure === "files") h.facts.changedFiles = 2;
      if (failure === "hold")
        setExternalMergeHold(store, "sample", 7, "CAPCOM: waiting for the demo");
      if (failure === "fork") h.wire.head.repo.full_name = "another/fork";
      expect((await mergeExternalPr(h.deps)).isError).toBe(true);
      expect(h.merges).toHaveLength(0);
    },
  );

  it("requires actual head-bound controller evidence for FLIGHT's own runtime changes", async () => {
    const h = harness();
    h.state.files = [{ filename: "apps/server/src/runtime/supervisor.ts", status: "modified" }];
    expect((await mergeExternalPr(h.deps)).isError).toBe(true);
    const control = externalPrControl(store, "sample", 7, SHA);
    expect(control).toMatchObject({
      controllerRequired: true,
      controllerPassed: false,
      protectedController: true,
    });
    expect(reviewCheckFor(store, "sample", 101)(pr)).toMatchObject({
      kind: "held",
      by: "operator",
    });
    expect(h.merges).toHaveLength(0);
  });

  it("uses a controller approval only for protected paths and rechecks its expiry", async () => {
    const h = harness();
    h.state.files = [{ filename: ".github/workflows/ci.yml", status: "modified" }];
    expect((await mergeExternalPr(h.deps)).text).toContain("requires controller approval");
    grantApproval(
      store,
      {
        rule: "merge-floor",
        scope: mergeFloorScope(7, SHA),
        until: 150,
        reason: "Reviewed this head.",
      },
      90,
    );
    h.state.ruleReads = 0;
    h.state.expireOnFinalRead = true;
    expect((await mergeExternalPr(h.deps)).isError).toBe(true);
    expect(h.merges).toHaveLength(0);
    h.state.clock = 100;
    h.state.expireOnFinalRead = false;
    expect((await mergeExternalPr(h.deps)).isError).toBeUndefined();
  });

  it("does not demand an approval for prose changes that leave Mission Control unchanged", async () => {
    const h = harness();
    h.state.files = [{ filename: "CLAUDE.md", status: "modified" }];
    expect((await mergeExternalPr(h.deps)).isError).toBeUndefined();
  });

  it("accepts real operator evidence, blocks FLIGHT self-approval, and preserves operator holds", async () => {
    const h = harness();
    h.state.files = [{ filename: "apps/server/src/runtime/supervisor.ts", status: "modified" }];
    h.state.rules.uat.paths = ["apps/server/**"];
    await mergeExternalPr(h.deps);
    store.upsertRun({
      id: "flight:1",
      agentId: "flight",
      repoId: "sample",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      model: "opus",
      sessionId: null,
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
    });
    const app = await buildApp({
      config,
      store,
      bus: h.deps.bus,
      gh: h.deps.gh,
      operatorToken: TOKEN,
    });
    const call = (suffix: string, body: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/prs/sample/7/${suffix}`,
        headers: { "x-mc-operator": TOKEN, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
    const flight = operatorCall(() => app, TOKEN);
    const actor = { seatId: "flight", runId: "flight:1" };
    try {
      expect(prAcceptanceFor(store, "sample")(pr)).toEqual({ uat: { sha: SHA, since: 100 } });
      expect(
        (
          await flight({
            method: "POST",
            path: "/api/prs/sample/7/controller-check",
            body: { sha: SHA, verdict: "pass" },
            actor,
          })
        ).status,
      ).toBe(403);
      expect(
        (await flight({ method: "POST", path: "/api/flight/approvals", body: {}, actor })).status,
      ).toBe(403);
      expect(
        (
          await flight({
            method: "POST",
            path: "/api/prs/sample/7/uat",
            body: { sha: SHA, action: "accept" },
            actor,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("controller-check", {
            sha: SHA,
            verdict: "pass",
            note: "Independent controller checked this head.",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call("uat", {
            sha: SHA,
            action: "send_back",
            note: "The controller asks for one more visual check.",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        prUat({
          store,
          pr,
          previewUrl: null,
          runCommand: undefined,
          singleRepo: true,
          repoOfSender: () => null,
        }).uat,
      ).toMatchObject({ waiting: true, note: "The controller asks for one more visual check." });
      expect((await call("uat", { sha: BASE, action: "accept" })).statusCode).toBe(409);
      expect((await call("uat", { sha: SHA, action: "accept" })).statusCode).toBe(200);
      expect(
        (await call("merge-hold", { sha: SHA, action: "hold", reason: "Wait for the release." }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await flight({
            method: "POST",
            path: "/api/prs/sample/7/merge-hold",
            body: { sha: SHA, action: "release" },
            actor,
          })
        ).status,
      ).toBe(403);
      expect((await mergeExternalPr(h.deps)).isError).toBe(true);
      expect((await call("merge-hold", { sha: SHA, action: "release" })).statusCode).toBe(200);
      expect((await mergeExternalPr(h.deps)).isError).toBeUndefined();
      expect(
        store
          .hubEvents(0)
          .some((event) => event.text.includes(`accepted external PR sample#7 at ${SHA}`)),
      ).toBe(true);
      store.upsertPullRequests("sample", [{ ...pr, headSha: BASE }], 200);
      expect(prAcceptanceFor(store, "sample")({ ...pr, headSha: BASE })).toEqual({});
      expect(externalPrControl(store, "sample", 7, BASE)).toBeNull();
    } finally {
      await app.close();
    }
  });
});
