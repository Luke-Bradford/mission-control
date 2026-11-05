import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PullRequestView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodeHealthAudit } from "../src/code-health/audit.ts";
import { groupRecommendations } from "../src/code-health/groups.ts";
import { CodeHealthReader } from "../src/code-health/read.ts";
import { type Proposal, upsertRecommendation } from "../src/code-health/recommendations.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 5),
  DAY = 86_400_000,
  SHA = "a".repeat(40);
const pr = (number: number, branch: string, patch: Partial<PullRequestView> = {}) =>
  ({
    repoId: "sample",
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/sample/pull/${number}`,
    branch,
    base: "main",
    ticket: null,
    state: "merged",
    isDraft: false,
    review: null,
    ci: "passing",
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - DAY,
    mergedAt: NOW - DAY,
    headSha: SHA,
    mergeable: null,
    ...patch,
  }) as PullRequestView;
const CHECKOUT = "/fixture/checkout";
const config = {
  repos: [{ id: "sample" }],
  crew: { sessions: [{ repoId: "sample", checkout: CHECKOUT }] },
} as never;

describe("code-health audit", () => {
  let dir: string, store: Store, db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-audit-"));
    const file = join(dir, "fixture.sqlite");
    store = new Store(file);
    db = new DatabaseSync(file);
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const audit = (at = NOW) => runCodeHealthAudit({ store, config, now: () => at });
  function review(id: number, number: number, round = 1, author = `run-${id}`) {
    db.prepare(
      `INSERT INTO reviews(id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)VALUES(?,?,'sample','reviewer',?,?,0,1,?,'reported',?,?)`,
    ).run(id, author, number, SHA, round, NOW - 2 * DAY, NOW - 2 * DAY);
  }
  function finding(reviewId: number, pos: number, category: string) {
    db.prepare(
      `INSERT INTO review_findings(review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,category,state)VALUES(?,?,?,'Minor','src/a.ts',1,'x','x','x',?,'open')`,
    ).run(reviewId, `run-${reviewId}`, pos, category);
  }
  function proposal(rule: string, subject: string, patch: Record<string, unknown> = {}): Proposal {
    return {
      id: `chr_${subject.padEnd(32, "0").slice(0, 32)}`,
      repoId: "sample",
      rule,
      ruleVersion: 1,
      scope: null,
      evidenceFingerprint: "f",
      observation: "observed",
      proposal: "propose",
      uncertainty: "unsure",
      rankingReason: "ranked",
      target: { metric: "m", direction: "decrease", baseline: 5 },
      ...patch,
    } as Proposal;
  }

  describe("merged PR review record", () => {
    it("leaves a record for a PR whose build run ended and for a hand-merged PR", () => {
      store.upsertPullRequests("sample", [pr(1, "feature/ended"), pr(2, "feature/by-hand")], NOW);
      store.upsertRun({
        id: "builder:1",
        agentId: "builder",
        repoId: "sample",
        seq: 1,
        startedAt: NOW - 4 * DAY,
        endedAt: NOW - 3 * DAY,
        status: "ok",
        model: null,
        sessionId: null,
        branch: "feature/ended",
        ticket: "sample#1",
        costUsd: null,
        tokens: null,
        transcriptPath: "",
        prs: [],
        summary: null,
      });
      review(10, 1, 1, "external-pr:sample#1");
      audit();
      const records = store.codeHealthMergedReviews("sample");
      expect(records.map((r) => [r.pr, r.merge, r.reviewId])).toEqual([
        [1, "ended-run", 10],
        [2, "hand", null],
      ]);
    });
    it("records each merged PR once and links a review that lands later", () => {
      store.upsertPullRequests("sample", [pr(2, "feature/by-hand")], NOW);
      audit();
      audit();
      expect(store.codeHealthMergedReviews("sample")).toHaveLength(1);
      review(11, 2);
      audit();
      expect(store.codeHealthMergedReviews("sample")[0]?.reviewId).toBe(11);
    });
  });

  describe("FLIGHT accepting a proposal", () => {
    const tier = () => proposal("repeatedly-changed-large-file", "bloat");
    it("accepts a FLIGHT-tier proposal with no owner or date, and records who and why", () => {
      const row = tier();
      upsertRecommendation(db, row, NOW);
      const accepted = store.flightAcceptCodeHealth(
        "sample",
        row.id,
        "flight-1",
        "Safe to split",
        NOW,
      );
      expect(accepted.state.kind).toBe("accepted");
      expect(accepted.owner).toContain("flight-1");
      expect(accepted.reviewAt).toBeGreaterThan(NOW);
      const decision = store.flightDecisions(0, 10).at(-1);
      expect(decision?.seatId).toBe("flight-1");
      expect(decision?.basis).toBe("Safe to split");
    });
    it.each(["recurring-correction", "repeated-rounds", "collection"])(
      "refuses %s, which stays with the operator",
      (rule) => {
        const row = proposal(rule, rule);
        upsertRecommendation(db, row, NOW);
        expect(() =>
          store.flightAcceptCodeHealth("sample", row.id, "flight-1", "Try", NOW),
        ).toThrow(/operator/);
        expect(store.codeHealthRecommendation("sample", row.id)?.state.kind).toBe("proposed");
      },
    );
  });

  describe("re-measuring accepted proposals", () => {
    function accept(row: Proposal, reviewAt: number) {
      upsertRecommendation(db, row, NOW - 10 * DAY);
      db.prepare(
        "UPDATE code_health_recommendations SET state=?,baseline=?,owner='o',review_at=? WHERE id=?",
      ).run(
        JSON.stringify({ kind: "accepted", owner: "o", reviewAt, linkedWork: null }),
        JSON.stringify({
          observation: "o",
          scope: null,
          fingerprint: "f",
          target: row.target,
          acceptedAt: NOW - 10 * DAY,
        }),
        reviewAt,
        row.id,
      );
    }
    const scope = {
      file: "src/a.ts",
      category: "spec",
      from: 0,
      until: 0,
      observedFrom: null,
      observedUntil: null,
    };
    it("measures an accepted proposal past its date with no manual call, and not one before it", () => {
      const due = proposal("recurring-correction", "due", { scope });
      const early = proposal("recurring-correction", "early", { scope });
      accept(due, NOW - 1000);
      accept(early, NOW + DAY);
      review(20, 30);
      finding(20, 0, "spec");
      audit();
      const result = store.codeHealthRecommendation("sample", due.id)?.remeasure;
      expect(result).toMatchObject({ baseline: 5, current: 1, change: "improved" });
      expect(store.codeHealthRecommendation("sample", early.id)?.remeasure).toBeNull();
      expect(store.codeHealthRecommendation("sample", due.id)?.state.kind).toBe("accepted");
    });
    it("keeps the first result", () => {
      const due = proposal("recurring-correction", "due", { scope });
      accept(due, NOW - 1000);
      review(20, 30);
      finding(20, 0, "spec");
      audit();
      finding(20, 1, "spec");
      audit(NOW + DAY);
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure?.current).toBe(1);
    });
    const big = () =>
      proposal("repeatedly-changed-large-file", "big", {
        target: { metric: "lines", direction: "decrease", baseline: 1500 },
        scope: {
          kind: "file-risk",
          file: "src/big.ts",
          from: 0,
          until: 0,
          observedFrom: null,
          observedUntil: null,
        },
      });
    const sizes = (n: number, files: { path: string; lines: number }[], at: number) =>
      store.recordCodeHealthSizeSnapshot(
        "sample",
        CHECKOUT,
        {
          version: 1,
          analysedSha: n.toString(16).repeat(40).slice(0, 40),
          files,
          excludedBinaryFiles: 0,
          elapsedMs: 1,
        },
        at,
      );
    it("counts a file that was broken up and removed as improved", () => {
      const due = big();
      accept(due, NOW - 1000);
      sizes(
        1,
        [
          { path: "src/big/a.ts", lines: 300 },
          { path: "src/big/b.ts", lines: 300 },
        ],
        NOW - 10,
      );
      audit();
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure).toMatchObject({
        baseline: 1500,
        current: 0,
        change: "improved",
      });
    });
    it("measures the shrunk file", () => {
      const due = big();
      accept(due, NOW - 1000);
      sizes(2, [{ path: "src/big.ts", lines: 400 }], NOW - 10);
      audit();
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure).toMatchObject({
        current: 400,
        change: "improved",
      });
    });
    it("tries again when sizes are not collected yet, and gives up after 7 days", () => {
      const due = big();
      accept(due, NOW - 1000);
      audit();
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure).toBeNull();
      sizes(3, [{ path: "src/big.ts", lines: 400 }], NOW + 3_600_000);
      audit(NOW + 3_600_000);
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure).toMatchObject({
        current: 400,
        change: "improved",
      });
      const late = proposal("repeatedly-changed-large-file", "late", {
        target: { metric: "lines", direction: "decrease", baseline: 1500 },
        scope: {
          kind: "file-risk",
          file: "src/late.ts",
          from: 0,
          until: 0,
          observedFrom: null,
          observedUntil: null,
        },
      });
      accept(late, NOW + 2 * DAY);
      store.remeasureCodeHealth("sample", NOW + 3 * DAY, undefined);
      expect(store.codeHealthRecommendation("sample", late.id)?.remeasure).toBeNull();
      store.remeasureCodeHealth("sample", NOW + 10 * DAY, undefined);
      expect(store.codeHealthRecommendation("sample", late.id)?.remeasure?.change).toBe(
        "unmeasured",
      );
    });
    it("says unmeasured when the metric cannot be read", () => {
      const due = proposal("collection", "gap");
      accept(due, NOW - 1000);
      audit();
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure?.change).toBe(
        "unmeasured",
      );
    });
  });

  describe("deriving a cause from review findings", () => {
    it("names the most common category, breaks ties alphabetically and says uncategorised", () => {
      const prs: [number, number, string[]][] = [
        [40, 40, ["spec", "spec", "docs"]],
        [41, 41, ["spec"]],
        [42, 42, ["docs", "docs", "spec"]],
        [43, 43, ["spec", "docs"]],
        [44, 44, []],
      ];
      for (const [number, id, categories] of prs) {
        review(id, number, 3);
        for (const [pos, category] of categories.entries()) finding(id, pos, category);
      }
      store.refreshCodeHealthRecommendations("sample", NOW);
      const causes = Object.fromEntries(
        store
          .codeHealthRecommendations("sample")
          .filter((row) => row.rule === "repeated-rounds")
          .map((row) => [row.scope?.pr, row.scope?.cause]),
      );
      expect(causes).toEqual({
        40: "spec",
        41: "spec",
        42: "docs",
        43: "docs",
        44: "uncategorised",
      });
      const reader = new CodeHealthReader(store, config, () => NOW);
      const groups = reader.recommendationHistory("sample", 0).groups;
      expect(groups.map((g) => [g.cause, g.prs])).toEqual([
        ["docs", [42, 43]],
        ["spec", [40, 41]],
        ["uncategorised", [44]],
      ]);
    });
    it("groups every undecided proposal of a cause, whatever page it falls on", () => {
      for (let n = 100; n < 160; n++)
        upsertRecommendation(
          db,
          proposal("repeated-rounds", `many${n}`, {
            scope: {
              pr: n,
              cause: "spec",
              from: 0,
              until: 0,
              observedFrom: null,
              observedUntil: null,
            },
          }),
          NOW,
        );
      const reader = new CodeHealthReader(store, config, () => NOW);
      const first = reader.recommendationHistory("sample", 0);
      expect(first.groups).toHaveLength(1);
      expect(first.groups[0]?.prs).toHaveLength(60);
      expect(reader.recommendationHistory("sample", 50).groups).toEqual([]);
    });
  });

  describe("grouping one-per-PR proposals", () => {
    it("reads proposals with one cause back as one group listing each PR", () => {
      for (const [n, cause] of [
        [31, "spec"],
        [32, "spec"],
        [33, "spec"],
        [34, "docs"],
      ] as const)
        upsertRecommendation(
          db,
          proposal("repeated-rounds", `pr${n}`, {
            scope: { pr: n, cause, from: 0, until: 0, observedFrom: null, observedUntil: null },
          }),
          NOW,
        );
      const groups = groupRecommendations(store.codeHealthRecommendations("sample"));
      const spec = groups.find((g) => g.cause === "spec");
      expect(spec?.prs).toEqual([31, 32, 33]);
      expect(spec?.proposalIds).toHaveLength(3);
      expect(groups.find((g) => g.cause === "docs")?.prs).toEqual([34]);
      expect(groups).toHaveLength(2);
    });
  });
});
