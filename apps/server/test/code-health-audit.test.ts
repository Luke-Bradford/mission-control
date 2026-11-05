import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PullRequestView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodeHealthAudit } from "../src/code-health/audit.ts";
import { groupRecommendations } from "../src/code-health/groups.ts";
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
const config = { repos: [{ id: "sample" }] } as never;

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
    it("says unmeasured when the metric cannot be read", () => {
      const due = proposal("collection", "gap");
      accept(due, NOW - 1000);
      audit();
      expect(store.codeHealthRecommendation("sample", due.id)?.remeasure?.change).toBe(
        "unmeasured",
      );
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
