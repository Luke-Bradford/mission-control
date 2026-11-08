import {
  isReviewBudgetFailure,
  NEW_LOOP,
  type PullRequestView,
  type RunHandoff,
  reviewBudgetFailure,
  reviewCheckOf,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { reviewerOf } from "../src/engine/engine.ts";
import {
  askExternalReview,
  externalReviewAsked,
  seedExternalReviewAsks,
  withdrawExternalReview,
} from "../src/external-pr-control.ts";
import { branchOwned, createExternalReviews, externalReviewKey } from "../src/external-reviews.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { ownsPr } from "../src/ownership.ts";
import { prUat } from "../src/pr-uat.ts";
import { reviewCheckFor } from "../src/review-check.ts";
import { Store } from "../src/store.ts";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const pr = (patch: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "sample",
  number: 7,
  title: "Sample change",
  url: "https://github.com/example/sample/pull/7",
  branch: "feature/sample",
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
  changedFiles: 1,
  files: [{ path: "apps/server/src/example.ts", changeType: "MODIFIED" }],
  ...patch,
});
const wire = (patch: Record<string, unknown> = {}) => ({
  number: 7,
  state: "open",
  draft: false,
  title: "Sample change",
  body: "## Why\nA small change.",
  labels: [],
  head: { sha: SHA, ref: "feature/sample", repo: { full_name: "example/sample" } },
  base: { ref: "main", repo: { full_name: "example/sample", default_branch: "main" } },
  ...patch,
});
const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [],
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
};
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
  store.upsertPullRequests("sample", [pr()], 1);
  // a review is asked-for work: the operator or FLIGHT asked this hub to review PR 7
  askExternalReview(store, "sample", 7, "CAPCOM", 1, SHA);
});
afterEach(() => store.close());

function harness() {
  let current = wire();
  const comments: { body: string }[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const gh: GhRunner = vi.fn(async (args, options) => {
    if (args.includes("POST")) {
      const path = args[args.indexOf("POST") + 1]!;
      const body = JSON.parse(options.input ?? "{}");
      writes.push({ path, body });
      if (path.endsWith("/comments")) comments.push(body);
      return result({ id: writes.length });
    }
    if (args[1]?.includes("/comments?")) return result([comments]);
    return result(current);
  });
  const deps = {
    config,
    store,
    gh,
    cwd: "/fixture",
    reviewer: () => "retro",
    textAllowed: async () => true,
    now: () => 100,
    log: vi.fn(),
  };
  return {
    deps,
    writes,
    comments,
    current: (patch: Record<string, unknown>) => {
      current = wire(patch);
    },
  };
}

describe("external PR review subjects", () => {
  it("queues nothing and writes nothing for a PR nobody asked this hub to review", async () => {
    store.deleteSetting("external-review-ask:sample#7");
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("reviews an ended run's PR with no ask, because a run here made the branch", async () => {
    store.deleteSetting("external-review-ask:sample#7");
    store.upsertRun({
      id: "r1",
      agentId: "guido-1",
      repoId: "sample",
      seq: 1,
      startedAt: 1,
      endedAt: 2,
      status: "ok",
      sessionId: null,
      model: null,
      branch: "feature/sample",
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      reviewId: null,
    });
    const h = harness();
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toHaveLength(1);
  });

  it("an ask withdrawn stops the review", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    const row = store.reviewsOfRun(externalReviewKey("sample", 7))[0]!;
    expect(service.wanted(row)).toBe(true);
    expect(withdrawExternalReview(store, "sample", 7)).toBe(true);
    expect(withdrawExternalReview(store, "sample", 7)).toBe(false);
    expect(service.wanted(row)).toBe(false);
  });

  it("Update seeds an ask for each review already in flight, once", async () => {
    const h = harness();
    await createExternalReviews(h.deps).sync();
    store.deleteSetting("external-review-ask:sample#7");
    seedExternalReviewAsks(store, 5);
    expect(externalReviewAsked(store, "sample", 7, SHA, true)).toBe(true);
    expect(externalReviewAsked(store, "sample", 7, NEXT, true)).toBe(false);
    // it counts for finishing that review only: not for card moves or PR body edits
    expect(externalReviewAsked(store, "sample", 7, SHA)).toBe(false);
    expect(ownsPr(store, "sample", pr())).toBe(false);
    withdrawExternalReview(store, "sample", 7);
    seedExternalReviewAsks(store, 6);
    expect(externalReviewAsked(store, "sample", 7, SHA, true)).toBe(false);
  });

  it("a seeded ask keeps the in-flight review wanted, with no run here", async () => {
    const h = harness();
    await createExternalReviews(h.deps).sync();
    const row = store.reviewsOfRun(externalReviewKey("sample", 7))[0]!;
    store.deleteSetting("external-review-ask:sample#7");
    seedExternalReviewAsks(store, 5);
    const service = createExternalReviews(h.deps);
    expect(service.wanted(row)).toBe(true);
    await service.sync();
    expect(store.review(row.id)?.state).not.toBe("superseded");
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toHaveLength(1);
  });

  it.each([
    ["reported", ["starting", "running", "reported"]],
    ["failed", ["starting", "running", "failed"]],
  ] as const)("Update seeds no ask for a %s review", async (_name, path) => {
    const h = harness();
    await createExternalReviews(h.deps).sync();
    const row = store.reviewsOfRun(externalReviewKey("sample", 7))[0]!;
    let from: "queued" | "starting" | "running" = "queued";
    for (const to of path) {
      store.setReviewState(row.id, [from], to, { at: 3, runId: "retro:x", failure: "x" });
      from = to as typeof from;
    }
    expect(store.review(row.id)?.state).toBe(path.at(-1));
    store.deleteSetting("external-review-ask:sample#7");
    seedExternalReviewAsks(store, 5);
    expect(externalReviewAsked(store, "sample", 7, SHA, true)).toBe(false);
  });

  it("Update seeds no ask when no review is in flight", () => {
    store.deleteSetting("external-review-ask:sample#7");
    seedExternalReviewAsks(store, 5);
    expect(externalReviewAsked(store, "sample", 7, SHA)).toBe(false);
  });

  it("an older queued row with no ask is no longer wanted", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    const row = store.reviewsOfRun(externalReviewKey("sample", 7))[0]!;
    expect(service.wanted(row)).toBe(true);
    store.deleteSetting("external-review-ask:sample#7");
    expect(service.wanted(row)).toBe(false);
  });

  it("queues one exact-head review without adding a developer run and survives restart", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    await service.sync();
    await createExternalReviews(h.deps).sync();
    const reviews = store.reviewsOfRun(externalReviewKey("sample", 7));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ sha: SHA, state: "queued", seatId: "retro", round: 1 });
    expect(store.runsActiveSince(0)).toHaveLength(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      path: `repos/example/sample/statuses/${SHA}`,
      body: { context: "mc/review", state: "pending" },
    });
  });

  it.each([
    { draft: true },
    { state: "closed" },
    { number: 8 },
    { head: { sha: NEXT, ref: "feature/sample", repo: { full_name: "example/sample" } } },
    { head: { sha: SHA, ref: "feature/sample", repo: { full_name: "untrusted/fork" } } },
    { base: { ref: "stacked", repo: { full_name: "example/sample", default_branch: "main" } } },
    { base: { ref: "main", repo: { full_name: "another/repo", default_branch: "main" } } },
    { labels: [{ name: "skip-review" }] },
    { labels: null },
    { labels: [null] },
  ])("refuses untrusted or opted-out metadata: %j", async (patch) => {
    const h = harness();
    h.current(patch);
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it.each([{ isDraft: true }, { ci: "pending" as const }, { ci: "failing" as const }])(
    "does not queue a draft or a head without passing CI: %j",
    async (patch) => {
      store.upsertPullRequests("sample", [pr(patch)], 2);
      const h = harness();
      await createExternalReviews(h.deps).sync();
      expect(store.reviewsIn(["queued"])).toHaveLength(0);
    },
  );

  const buildRun = (patch: Record<string, unknown>) =>
    store.upsertRun({
      id: "builder:old",
      agentId: "builder",
      repoId: "sample",
      seq: 1,
      startedAt: 1,
      endedAt: 2,
      status: "ok",
      model: null,
      sessionId: null,
      branch: "feature/sample",
      ticket: "sample#1",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      ...patch,
    });

  it("reviews a PR whose only build run has ended", async () => {
    buildRun({ endedAt: 2 });
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    expect(store.reviewsIn(["queued"])).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
    expect(service.wanted(store.reviewsOfRun(externalReviewKey("sample", 7))[0]!)).toBe(true);
  });

  it("does not review a branch whose build run is still unfinished", async () => {
    buildRun({ endedAt: null, status: "running", loop: { ...NEW_LOOP, phase: "parked" } });
    const h = harness();
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("stops wanting a queued review once a run is unfinished on the branch", async () => {
    buildRun({ endedAt: 2 });
    const service = createExternalReviews(harness().deps);
    await service.sync();
    const queued = store.reviewsOfRun(externalReviewKey("sample", 7))[0]!;
    expect(service.wanted(queued)).toBe(true);
    buildRun({ id: "builder:new", endedAt: null, status: "running" });
    expect(service.wanted(queued)).toBe(false);
  });

  it("queues a later round, avoiding the ended author's seat, after a crew review of an older head", async () => {
    buildRun({ endedAt: 2 });
    const crew = store.requestReview({
      authorRunId: "builder:old",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: NEXT,
      epoch: 1,
      attempt: 1,
      round: 1,
      at: 1,
    })!;
    store.setReviewState(crew, ["queued"], "running", { runId: "retro:x", at: 2 });
    store.recordFindings(crew, "retro:x", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "findings",
      findings: [],
      at: 3,
    });
    const h = harness();
    const reviewer = vi.fn((_repo: string, _pick?: { author?: string | undefined }) => "retro");
    await createExternalReviews({ ...h.deps, reviewer }).sync();
    expect(reviewer).toHaveBeenCalledWith("sample", expect.objectContaining({ author: "builder" }));
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))[0]).toMatchObject({ round: 2 });
  });

  it("tries a review that ran out of tokens again on the other review seat", async () => {
    buildRun({ endedAt: 2 });
    const seat = (id: string) => ({
      id,
      role: "RETRO",
      mode: "scratch",
      accountId: "a",
      model: "opus",
      area: [],
    });
    const crew = {
      ...config,
      crew: { sessions: [{ id: "s", repoId: "sample", seats: [seat("retro"), seat("retro-2")] }] },
    } as unknown as CcConfig;
    const h = harness();
    const deps = {
      ...h.deps,
      reviewer: (
        _repo: string,
        pick?: { role?: string | undefined; avoid?: ReadonlySet<string> },
      ) =>
        reviewerOf(crew, "retro", pick?.role, {
          store,
          now: 100,
          ...(pick?.avoid === undefined ? {} : { avoid: pick.avoid }),
        })?.id ?? null,
    };
    const service = createExternalReviews(deps);
    await service.sync();
    const key = externalReviewKey("sample", 7);
    const first = store.reviewsOfRun(key)[0]!;
    expect(first.seatId).toBe("retro");
    store.setReviewState(first.id, ["queued"], "running", { runId: "retro:x", at: 3 });
    store.setReviewState(first.id, ["running"], "failed", {
      at: 4,
      failure: reviewBudgetFailure(1000),
    });
    expect(isReviewBudgetFailure(store.review(first.id)?.failure ?? null)).toBe(true);
    await service.sync();
    const rows = store.reviewsOfRun(key);
    expect(rows.map((r) => r.seatId)).toEqual(["retro", "retro-2"]);
    // with no other seat to try, the failed review stands and nothing more is queued
    await service.sync();
    store.setReviewState(rows[1]!.id, ["queued"], "running", { runId: "retro-2:x", at: 5 });
    store.setReviewState(rows[1]!.id, ["running"], "failed", {
      at: 6,
      failure: reviewBudgetFailure(1000),
    });
    await service.sync();
    expect(store.reviewsOfRun(key)).toHaveLength(2);
  });

  describe("branchOwned", () => {
    it("holds a branch a seat has claimed the handoff of before its run row exists", () => {
      buildRun({ endedAt: 2 });
      expect(branchOwned(config, store, "sample", "feature/sample")).toBe(false);
      store.recordHandoff({
        runId: "builder:old",
        repoId: "sample",
        ticket: "sample#1",
        branch: "feature/sample",
        at: 2,
      } as RunHandoff);
      expect(store.claimHandoff("builder:old", "token")).toBe(true);
      expect(branchOwned(config, store, "sample", "feature/sample")).toBe(true);
      // a PR head under another ref is held through the ticket
      expect(branchOwned(config, store, "sample", "feature/other")).toBe(false);
      expect(branchOwned(config, store, "sample", "feature/other", "sample#1")).toBe(true);
      store.acceptHandoff("builder:old", "token", "guido-2", "guido-2:new");
      expect(branchOwned(config, store, "sample", "feature/sample")).toBe(false);
    });

    it("holds a PR whose ticket has a live run on another branch", () => {
      buildRun({ id: "builder:live", endedAt: null, status: "running", branch: "feature/live" });
      expect(branchOwned(config, store, "sample", "feature/sample")).toBe(false);
      expect(branchOwned(config, store, "sample", "feature/sample", "sample#1")).toBe(true);
    });

    it("keeps every run of a configured loop out of the external path", () => {
      buildRun({ endedAt: 2 });
      const withLoop = { ...config, loops: [{ id: "builder" }] } as unknown as CcConfig;
      expect(branchOwned(config, store, "sample", "feature/sample")).toBe(false);
      expect(branchOwned(withLoop, store, "sample", "feature/sample")).toBe(true);
    });
  });

  it("reviews an ended run's PR when the mc/review status on its head is this hub's own", async () => {
    buildRun({ id: "builder:ended", endedAt: 2 });
    store.requestReview({
      authorRunId: "builder:ended",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 1,
      attempt: 1,
      round: 1,
      at: 1,
    });
    store.upsertPullRequests(
      "sample",
      [
        pr({
          checks: [
            {
              name: "mc/review",
              state: "passing",
              kind: "status",
              conclusion: "success",
              attempt: null,
              url: null,
            },
          ],
        }),
      ],
      2,
    );
    const h = harness();
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toHaveLength(1);
  });

  it("leaves a configured loop's branch alone, ended iteration or not", async () => {
    buildRun({ agentId: "shop-ta", endedAt: 2 });
    const h = harness();
    const loops = [{ id: "shop-ta", repoId: "sample" }] as unknown as CcConfig["loops"];
    const deps = { ...h.deps, config: { ...config, loops } };
    await createExternalReviews(deps).sync();
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("reviews an ended run's PR whose head carries a mc/review status with no review row", async () => {
    buildRun({ endedAt: 2 });
    store.upsertPullRequests(
      "sample",
      [
        pr({
          checks: [
            {
              name: "mc/review",
              state: "passing",
              kind: "status",
              conclusion: "success",
              attempt: null,
              url: null,
            },
          ],
        }),
      ],
      2,
    );
    const h = harness();
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toHaveLength(1);
  });

  it("requeues on a new SHA and never carries an old verdict onto it", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    const old = store.reviewsIn(["queued"])[0]!;
    store.upsertPullRequests("sample", [pr({ headSha: NEXT })], 2);
    h.current({
      head: { sha: NEXT, ref: "feature/sample", repo: { full_name: "example/sample" } },
    });
    // the ask bound the old head: the push is not reviewed until someone asks for it
    await service.sync();
    expect(store.reviewsIn(["queued"]).map((row) => row.sha)).toEqual([SHA]);
    askExternalReview(store, "sample", 7, "CAPCOM", 3, NEXT);
    await service.sync();
    expect(service.wanted(old)).toBe(false);
    expect(store.reviewsIn(["queued"]).map((row) => row.sha)).toEqual([SHA, NEXT]);
    expect(h.writes.at(-1)).toMatchObject({
      path: `repos/example/sample/statuses/${NEXT}`,
      body: { state: "pending" },
    });
  });

  it.each([false, true])(
    "posts one durable report with actual screenshot availability (%s)",
    async (screenshots) => {
      const h = harness();
      const deps = {
        ...h.deps,
        ...(screenshots
          ? {
              evidence: {
                baseUrl: "http://preview.test",
                ensure: async () => {},
                gate: () => null,
                stop: async () => {},
              },
              evidenceManifest: () => ({
                repoId: "sample",
                pr: 7,
                sha: SHA,
                mainSha: NEXT,
                capturedAt: 90,
                pairs: [
                  {
                    page: "overview" as const,
                    scheme: "light" as const,
                    changedPixels: 1,
                    changedPercent: 0.1,
                    regions: [],
                  },
                ],
              }),
            }
          : {}),
      };
      const service = createExternalReviews(deps);
      await service.sync();
      const row = store.reviewsIn(["queued"])[0]!;
      store.setReviewState(row.id, ["queued"], "running", { at: 101, runId: "retro:review" });
      expect(
        store.recordFindings(row.id, "retro:review", {
          verdict: { spec: "pass", quality: "pass" },
          summary: "Checked the change.",
          findings: [],
          checked: [{ check: "spec", result: "pass" }],
          tests: [{ command: "pnpm test:related", passed: 3, failed: 0, skipped: 1, duration: 20 }],
          at: 102,
        }),
      ).toBe(true);
      await service.sync();
      await createExternalReviews(deps).sync();
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]?.body).toContain(SHA);
      expect(h.comments[0]?.body).toContain("3 passed, 0 failed, 1 skipped");
      if (screenshots) {
        expect(h.comments[0]?.body).toContain(`/${SHA}/overview-light-before.png`);
        expect(h.comments[0]?.body).toContain(`/${SHA}/overview-light-after.png`);
        expect(h.comments[0]?.body).toContain(NEXT.slice(0, 7));
      } else
        expect(h.comments[0]?.body).toContain("No before/after screenshot pairs were captured");
      expect(h.writes.at(-1)?.body).toMatchObject({ state: "success", context: "mc/review" });
      const details = prUat({
        store,
        pr: pr(),
        previewUrl: null,
        runCommand: undefined,
        singleRepo: true,
        repoOfSender: () => null,
      });
      expect(details.qaSummary).toBe("Checked the change.");
      expect(details.tests).toEqual([
        { command: "pnpm test:related", passed: 3, failed: 0, skipped: 1, duration: 20 },
      ]);
    },
  );

  it("posts the reported state of a crew review whose author run ended before it reported", async () => {
    store.upsertPullRequests("sample", [pr({ ticket: "sample#1" })], 2);
    buildRun({ endedAt: 2 });
    const id = store.requestReview({
      authorRunId: "builder:old",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 3,
    })!;
    store.setReviewState(id, ["queued"], "running", { at: 101, runId: "retro:review" });
    expect(
      store.recordFindings(id, "retro:review", {
        verdict: { spec: "pass", quality: "pass" },
        summary: "Checked the change.",
        findings: [],
        checked: [{ check: "spec", result: "pass" }],
        tests: [],
        at: 102,
      }),
    ).toBe(true);
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    await service.sync();
    // no second review of a head that already has its report
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.body).toContain(SHA);
    expect(h.writes.filter((w) => w.path.includes("/statuses/"))).toHaveLength(1);
    expect(h.writes.at(-1)?.body).toMatchObject({ state: "success", context: "mc/review" });
  });

  it("does not treat a crew review as orphaned while its author run is live", async () => {
    buildRun({
      endedAt: null,
      status: "running",
      branch: "other",
      ticket: null,
      loop: { ...NEW_LOOP, phase: "review" },
    });
    const id = store.requestReview({
      authorRunId: "builder:old",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 3,
    })!;
    store.setReviewState(id, ["queued"], "running", { at: 101, runId: "retro:review" });
    store.recordFindings(id, "retro:review", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Checked.",
      findings: [],
      checked: [{ check: "spec", result: "pass" }],
      tests: [],
      at: 102,
    });
    const h = harness();
    const service = createExternalReviews(h.deps);
    expect(service.wanted(store.review(id)!)).toBe(false);
  });

  it("says nothing and posts nothing for a crew review its live author run owns", async () => {
    buildRun({
      endedAt: null,
      status: "running",
      loop: { ...NEW_LOOP, phase: "review" },
    });
    const id = store.requestReview({
      authorRunId: "builder:old",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 3,
    })!;
    store.setReviewState(id, ["queued"], "running", { at: 101, runId: "retro:review" });
    store.recordFindings(id, "retro:review", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Checked.",
      findings: [],
      checked: [{ check: "spec", result: "pass" }],
      tests: [],
      at: 102,
    });
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    expect(h.writes).toEqual([]);
    expect(h.deps.log).not.toHaveBeenCalled();
  });

  it("says why when it leaves a reported review unposted", async () => {
    const id = store.requestReview({
      authorRunId: "gone:run",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 3,
    })!;
    store.setReviewState(id, ["queued"], "running", { at: 101, runId: "retro:review" });
    store.recordFindings(id, "retro:review", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Checked.",
      findings: [],
      checked: [{ check: "spec", result: "pass" }],
      tests: [],
      at: 102,
    });
    const h = harness();
    // the PR went back to draft: the report is left unposted, on purpose
    store.upsertPullRequests("sample", [pr({ isDraft: true })], 3);
    const service = createExternalReviews(h.deps);
    await service.sync();
    await service.sync();
    expect(h.writes).toEqual([]);
    expect(h.deps.log).toHaveBeenCalledTimes(1);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("sample#7"));
  });

  it("recovers an uncertain comment POST without duplicating the report", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    const row = store.reviewsIn(["queued"])[0]!;
    store.setReviewState(row.id, ["queued"], "running", { at: 101, runId: "retro:review" });
    store.recordFindings(row.id, "retro:review", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Checked.",
      findings: [],
      at: 102,
    });
    const gh: GhRunner = async (args, options) => {
      const reply = await h.deps.gh(args, options);
      return args.includes("POST") && args.some((arg) => arg.endsWith("/comments"))
        ? { code: 1, stdout: "", stderr: "lost reply" }
        : reply;
    };
    await createExternalReviews({ ...h.deps, gh }).sync();
    const paginated: GhRunner = async (args, options) => {
      if (args[1]?.includes("/comments?")) {
        expect(args).toContain("--paginate");
        expect(args).toContain("--slurp");
        return result([
          Array.from({ length: 100 }, () => ({ body: "Earlier comment" })),
          h.comments,
        ]);
      }
      return h.deps.gh(args, options);
    };
    await createExternalReviews({ ...h.deps, gh: paginated }).sync();
    expect(h.comments).toHaveLength(1);
    expect(h.writes.at(-1)?.body.state).toBe("success");
  });

  it("can queue the same head after an opted-out review was superseded", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    const old = store.reviewsIn(["queued"])[0]!;
    store.setReviewState(old.id, ["queued"], "superseded", { at: 101 });
    await service.sync();
    const current = store.reviewsIn(["queued"]);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ sha: SHA, attempt: 2 });
  });

  it("withholds a report containing disallowed text and never posts a clean status", async () => {
    const h = harness();
    await createExternalReviews(h.deps).sync();
    const row = store.reviewsIn(["queued"])[0]!;
    store.setReviewState(row.id, ["queued"], "running", { at: 101, runId: "retro:review" });
    store.recordFindings(row.id, "retro:review", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Sensitive content.",
      findings: [],
      at: 102,
    });
    await createExternalReviews({ ...h.deps, textAllowed: async () => false }).sync();
    expect(h.comments).toHaveLength(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.body.state).toBe("pending");
    expect(h.deps.log).toHaveBeenCalledWith(expect.not.stringContaining("Sensitive content"));
  });

  it("keeps a failed review red and does not repeatedly start paid retries", async () => {
    const h = harness();
    const service = createExternalReviews(h.deps);
    await service.sync();
    const row = store.reviewsIn(["queued"])[0]!;
    store.setReviewState(row.id, ["queued"], "failed", {
      at: 101,
      failure: "Reviewer ended without a report.",
    });
    await service.sync();
    await service.sync();
    expect(store.reviewsOfRun(externalReviewKey("sample", 7))).toHaveLength(1);
    expect(h.writes.at(-1)?.body).toMatchObject({ state: "failure" });
    expect(reviewCheckFor(store, "sample", 102)(pr())).toEqual({
      kind: "held",
      by: "hub",
      reason: "Reviewer ended without a report.",
    });
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
  });

  it("stops queue/status writes if the engine stops during the fresh read", async () => {
    const h = harness();
    let enabled = true;
    const gh: GhRunner = async (args, options) => {
      const reply = await h.deps.gh(args, options);
      enabled = false;
      return reply;
    };
    await createExternalReviews({ ...h.deps, gh, enabled: () => enabled }).sync();
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("does not block the engine on a screenshot build or queue ahead of required pairs", async () => {
    const h = harness();
    const ensure = vi.fn(() => new Promise<void>(() => {}));
    await createExternalReviews({
      ...h.deps,
      evidence: {
        baseUrl: "http://preview.test",
        ensure,
        gate: () => "missing screenshot pairs",
        stop: async () => {},
      },
    }).sync();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
  });

  it("honours a draft workspace and existing external mc/review status", async () => {
    const h = harness();
    await createExternalReviews({
      ...h.deps,
      config: { ...config, repos: [{ ...config.repos[0]!, autonomy: "draft" }] },
    }).sync();
    store.upsertPullRequests(
      "sample",
      [
        pr({
          checks: [
            {
              name: "mc/review",
              state: "passing",
              kind: "status",
              conclusion: "success",
              attempt: null,
              url: null,
            },
          ],
        }),
      ],
      2,
    );
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
  });
});

describe("current-head review read model", () => {
  function review(sha = SHA, authorRunId = externalReviewKey("sample", 7)) {
    const id = store.requestReview({
      authorRunId,
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 1,
    })!;
    store.setReviewState(id, ["queued"], "running", { at: 2, runId: "retro:review" });
    store.recordFindings(id, "retro:review", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Clean",
      findings: [],
      at: 3,
    });
    return id;
  }
  it("never shows an old report as ready on a newer known head", () => {
    review();
    expect(reviewCheckFor(store, "sample", 4)(pr({ headSha: NEXT }))).toBeNull();
    expect(reviewCheckFor(store, "sample", 4)(pr())).toEqual({ kind: "ready" });
  });
  it("does not revive an old report when the newer queued row is superseded", () => {
    review();
    const id = store.requestReview({
      authorRunId: externalReviewKey("sample", 7),
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: NEXT,
      epoch: 0,
      attempt: 1,
      round: 2,
      at: 4,
    })!;
    store.setReviewState(id, ["queued"], "superseded", { at: 5 });
    expect(reviewCheckFor(store, "sample", 6)(pr({ headSha: NEXT }))).toBeNull();
  });
  it("preserves an explicitly carried clean review with its matching epoch and destination", () => {
    store.upsertRun({
      id: "builder:1",
      agentId: "builder",
      repoId: "sample",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      model: null,
      sessionId: null,
      branch: "feature/sample",
      ticket: "sample#1",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      loop: { ...NEW_LOOP, carry: { from: SHA, to: NEXT } },
    });
    review(SHA, "builder:1");
    expect(reviewCheckFor(store, "sample", 4)(pr({ headSha: NEXT }))).toEqual({ kind: "ready" });
  });
  it("keeps the specific held reason without changing hold precedence", () => {
    const state = reviewCheckOf(
      [{ state: "reported", blocking: 0, seatId: "retro", createdAt: 1, startedAt: 2 }],
      0,
      {
        ...NEW_LOOP,
        phase: "parked",
        parked: { kind: "stuck", reason: "Waiting for the exact pushed head", ended: false },
      },
    );
    expect(state).toEqual({ kind: "held", by: "hub", reason: "Waiting for the exact pushed head" });
  });
});
