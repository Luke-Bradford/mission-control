import { NEW_LOOP, type PullRequestView, reviewCheckOf } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { createExternalReviews, externalReviewKey } from "../src/external-reviews.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
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
    buildRun({ endedAt: null, status: "parked" });
    const h = harness();
    await createExternalReviews(h.deps).sync();
    expect(store.reviewsIn(["queued"])).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
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
