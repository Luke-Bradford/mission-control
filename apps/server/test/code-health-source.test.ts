import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeHealthSourceRevision } from "../src/code-health/source.ts";
import { Store } from "../src/store.ts";

describe("code-health source projections", () => {
  let root: string;
  let store: Store;
  let db: DatabaseSync;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-code-health-source-"));
    const path = join(root, "fixture.sqlite");
    store = new Store(path);
    db = new DatabaseSync(path);
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function review(id: number, repo = "sample", at = 100, state = "reported") {
    db.prepare(`INSERT INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha,
      epoch, attempt, round, state, created_at, ended_at)
      VALUES (?, ?, ?, 'reviewer', ?, ?, 0, 1, 1, ?, ?, ?)`).run(
      id,
      `author-${id}`,
      repo,
      id,
      "a".repeat(40),
      state,
      at,
      at,
    );
  }

  it("selects reported parent reviews in a half-open repo/window", () => {
    review(1, "sample", 100);
    review(2, "sample", 199);
    review(3, "sample", 200);
    review(4, "other", 150);
    review(5, "sample", 150, "running");
    const source = store.codeHealthReviews("sample", 100, 200);
    expect(source.reviews.map((r) => r.pr)).toEqual([1, 2]);
    expect([source.observedFrom, source.observedUntil]).toEqual([100, 199]);
    expect(store.codeHealthReviews("absent", 100, 200)).toEqual({
      reviews: [],
      findings: [],
      observedFrom: null,
      observedUntil: null,
    });
  });

  it("retains finding disposition and resolution provenance without inventing carry links", () => {
    review(1);
    db.prepare(`INSERT INTO review_findings (review_id, author_run_id, pos, severity, file,
      line, summary, scenario, fix, category, state, resolution, resolved_review_id)
      VALUES (1, 'author-1', 0, 'Minor', 'src/example.ts', 1,
      'Example', 'Example', 'Example', 'spec', 'logged', 'held', 12)`).run();
    expect(store.codeHealthReviews("sample", 0, 200).findings[0]).toMatchObject({
      repoId: "sample",
      pr: 1,
      reviewId: "1",
      category: "spec",
      state: "logged",
      resolution: "held",
      resolvedReviewId: 12,
      carry: { kind: "unknown" },
    });
    expect(store.codeHealthReviews("other", 0, 200).findings).toEqual([]);
  });

  it("invalidates source revisions on external relevant writes, not unrelated settings", () => {
    const empty = store.codeHealthRevision("sample");
    review(1);
    const first = store.codeHealthRevision("sample");
    expect(first).not.toBe(empty);
    store.setSetting("fixture", "unrelated");
    expect(store.codeHealthRevision("sample")).toBe(first);
    review(2, "other");
    expect(store.codeHealthRevision("sample")).toBe(first);
    db.prepare("UPDATE reviews SET sha = ? WHERE id = 1").run("b".repeat(40));
    expect(store.codeHealthRevision("sample")).not.toBe(first);
  });

  it("changes both repo revisions when a source moves, and rolls back revision writes atomically", () => {
    review(1);
    const beforeSample = store.codeHealthRevision("sample");
    const beforeOther = store.codeHealthRevision("other");
    db.prepare("UPDATE reviews SET repo_id = 'other' WHERE id = 1").run();
    expect(store.codeHealthRevision("sample")).not.toBe(beforeSample);
    expect(store.codeHealthRevision("other")).not.toBe(beforeOther);
    const before = codeHealthSourceRevision(db, "sample");
    db.exec("BEGIN");
    review(2);
    expect(codeHealthSourceRevision(db, "sample")).not.toBe(before);
    db.exec("ROLLBACK");
    expect(codeHealthSourceRevision(db, "sample")).toBe(before);
  });

  it("reports mixed job candidates without claiming test attempts or chronological flakes", () => {
    const insert = db.prepare(`INSERT INTO ci_runs (repo_id, run_key, sha, name, attempt,
      pr_number, workflow, state, conclusion, first_seen_at, at)
      VALUES (?, ?, ?, 'unit', 1, 1, 'checks', 'COMPLETED', ?, ?, ?)`);
    insert.run("sample", "a", "a".repeat(40), "FAILURE", 100, 100);
    insert.run("sample", "b", "a".repeat(40), "SUCCESS", 150, 150);
    insert.run("sample", "c", "b".repeat(40), "SUCCESS", 150, 150);
    insert.run("other", "d", "b".repeat(40), "FAILURE", 150, 150);
    insert.run("sample", "e", "b".repeat(40), "FAILURE", 200, 200);
    expect(store.codeHealthCi("sample", 100, 200)).toEqual({
      observations: 3,
      observedFrom: 100,
      observedUntil: 150,
      mixedJobCandidates: 1,
      unnormalisedCommandRecords: 0,
    });
  });

  it("projects at most fifty size rows at a recorded SHA without returning imports", () => {
    const scope = "/example/checkouts/sample";
    const value = JSON.stringify({
      tree: Array.from({ length: 80 }, (_, i) => ({ path: `src/file-${i}.ts`, lines: i })),
      imports: [{ from: "private-marker", to: "not-an-output-field" }],
    });
    store.mapCachePut("tree", scope, "a".repeat(40), value, true);
    const result = store.codeHealthSizes(scope);
    expect(result?.analysedSha).toBe("a".repeat(40));
    expect(result?.files).toHaveLength(50);
    expect(result?.files[0]).toEqual({ path: "src/file-79.ts", lines: 79 });
    expect(JSON.stringify(result)).not.toContain("private-marker");
    expect(store.codeHealthSizes("/example/absent")).toBeNull();
  });

  it("rejects malformed and unsafe size snapshots", () => {
    const scope = "/example/checkouts/sample";
    for (const value of ["{", "{}", JSON.stringify({ tree: [{ path: "../outside", lines: 1 }] })]) {
      store.mapCachePut("tree", scope, "a".repeat(40), value, true);
      expect(() => store.codeHealthSizes(scope)).toThrow(/snapshot/);
    }
  });
});
