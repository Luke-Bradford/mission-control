import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QaReport } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { qaHistoryPage, qaNativeHistory } from "../src/qa/history.ts";
import { qaNativeIdentity } from "../src/qa/history-key.ts";
import { Store } from "../src/store.ts";

const config = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "merge" }],
} as CcConfig;
let dir: string, store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-qa-history-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function report(n: number, over: Partial<QaReport> = {}): QaReport {
  const id = n.toString(16).padStart(64, "0");
  return {
    schemaVersion: 1,
    id,
    repoId: "sample",
    github: "example/sample",
    prNumber: 7,
    headSha: n.toString(16).padStart(40, "a"),
    prTitle: "Retained change",
    prUrl: "https://github.com/example/sample/pull/7",
    source: "controller",
    reviewer: { id: "reviewer", label: "Recorded reviewer" },
    reviewedAt: null,
    registeredAt: 1000,
    verdict: { spec: "pass", quality: "pass" },
    summary: "Stored historical review.",
    worksWell: [],
    coverage: [],
    findings: [],
    resolutions: [],
    tests: [],
    ci: {
      observedAt: 999,
      headSha: n.toString(16).padStart(40, "a"),
      source: "github",
      checks: [
        {
          name: "ci",
          kind: "check",
          state: "passing",
          conclusion: "SUCCESS",
          url: "https://github.com/example/sample/actions/runs/1",
          attempt: 1,
        },
      ],
    },
    limitations: [],
    followUps: [],
    visual: { applicability: "not_applicable", reason: "Backend only.", pairs: [] },
    completeness: { state: "incomplete", missing: ["Original review time unknown"] },
    permalink: `/qa?repo=sample&pr=7&report=${id}`,
    ...over,
  };
}
function identity(id: number): string {
  const review = store.review(id);
  return review ? qaNativeIdentity(review) : "missing";
}
function native(
  n: number,
  repo = "sample",
  state: "reported" | "failed" | "superseded" = "reported",
  ended = 1000,
) {
  const id = store.requestReview({
    authorRunId: `author-${n}`,
    repoId: repo,
    seatId: `retro-${n}`,
    prNumber: 8,
    sha: n.toString(16).padStart(40, "b"),
    epoch: 1,
    attempt: 1,
    round: n,
    at: 500,
  });
  if (!id) throw new Error("fixture review missing");
  store.setReviewState(id, ["queued"], "running", { runId: `review-${n}`, at: 600 });
  if (state === "reported")
    store.recordFindings(id, `review-${n}`, {
      verdict: { spec: "fail", quality: "pass" },
      summary: "Actual original review summary.",
      findings: [
        {
          severity: "Important",
          file: "src/api.ts",
          line: 4,
          summary: "Missing validation",
          scenario: "Unknown input",
          fix: "Validate",
        },
      ],
      checked: [{ check: "authorization", result: "fail", note: "Original check." }],
      tests: [{ command: "pnpm test", passed: 3, failed: 1, skipped: 0, duration: 20 }],
      at: ended,
    });
  else
    store.setReviewState(id, ["running"], state, {
      at: ended,
      failure: "Attempt ended before a verdict.",
    });
  return id;
}
it("paginates saved versions and older native records without duplicates or unconfigured data", () => {
  const archivedNative = native(1);
  for (let n = 1; n <= 58; n++)
    store.putQaReport(
      report(
        n,
        n === 1
          ? {
              source: "native",
              nativeReviewId: archivedNative,
              reviewer: { id: "retro-1", label: "retro-1" },
              nativeRunId: "review-1",
              headSha: nativeHead(1),
              prNumber: 8,
            }
          : {},
      ),
    );
  const legacy = native(2),
    failed = native(3, "sample", "failed"),
    superseded = native(4, "sample", "superseded");
  native(5, "removed-repo");
  store.putQaReport(report(99, { repoId: "removed-repo" }));
  const seen = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = qaHistoryPage(store, config, { limit: "7", ...(cursor ? { cursor } : {}) });
    expect(page).not.toBeNull();
    for (const entry of page?.entries ?? []) {
      expect(seen.has(entry.key)).toBe(false);
      seen.set(entry.key, entry.headSha);
      expect(entry.repoId).toBe("sample");
    }
    cursor = page?.nextCursor ?? undefined;
  } while (cursor);
  expect(seen.size).toBe(61);
  expect(seen.has(`n:${archivedNative}`)).toBe(false);
  for (const id of [legacy, failed, superseded]) expect(seen.has(`n:${id}`)).toBe(true);
  expect(new Set(seen.values()).size).toBeGreaterThan(50);
});
it("keeps historical unknown time, failed attempts, CI and visual applicability honest", () => {
  native(1, "sample", "failed");
  store.putQaReport(report(1));
  store.putQaReport(
    report(2, {
      ci: { observedAt: 999, headSha: "a".repeat(40), source: "unavailable", checks: [] },
      visual: { applicability: "required", pairs: [] },
    }),
  );
  store.putQaReport(report(3, { ci: { ...report(3).ci, headSha: "f".repeat(40) } }));
  const entries = qaHistoryPage(store, config, {})?.entries ?? [];
  expect(entries.find((e) => e.kind === "native")).toMatchObject({
    reviewedAt: null,
    verdict: null,
    evidence: "legacy",
    ci: "unavailable",
    visual: "unknown",
  });
  expect(entries.find((e) => e.key === `r:${report(1).id}`)).toMatchObject({
    reviewedAt: null,
    ci: "passing",
    evidence: "incomplete",
    visual: "not_applicable",
  });
  expect(entries.find((e) => e.key === `r:${report(3).id}`)?.ci).toBe("unavailable");
  expect(entries.find((e) => e.key === `r:${report(2).id}`)).toMatchObject({
    ci: "unavailable",
    visual: "required",
    pairCount: 0,
  });
});
it("reads the original native checks/findings/reported counts without manufacturing a report", () => {
  const id = native(1);
  const before = store.qaReports("sample", 8);
  const value = qaNativeHistory(store, config, id, identity(id));
  expect(value?.review.summary).toBe("Actual original review summary.");
  expect(value?.coverage[0]).toMatchObject({ check: "authorization", result: "fail" });
  expect(value?.tests[0]).toMatchObject({ passed: 3, failed: 1 });
  expect(value?.findings[0].summary).toBe("Missing validation");
  expect(value?.limitations.join(" ")).toContain("reviewer-reported");
  expect(store.qaReports("sample", 8)).toEqual(before);
  expect(qaNativeHistory(store, config, native(2, "removed-repo"), "invalid")).toBeNull();
  const db = new DatabaseSync(store.path);
  db.prepare("DELETE FROM reviews WHERE id = ?").run(id);
  db.close();
  expect(qaNativeHistory(store, config, id, identity(id))).toBeNull();
});
it("keeps saved reports after native pruning and includes closed/unknown PRs with no live queue entry", () => {
  const id = native(1);
  const r = report(1, { nativeReviewId: id });
  store.putQaReport(r);
  const db = new DatabaseSync(store.path);
  db.prepare("DELETE FROM reviews WHERE id = ?").run(id);
  db.close();
  expect(qaHistoryPage(store, config, {})?.entries).toHaveLength(1);
  expect(qaHistoryPage(store, config, {})?.entries[0].permalink).toBe(r.permalink);
  expect(store.pullRequest("sample", 7)).toBeNull();
});
it("fails invalid/unconfigured queries closed and bounds page size", async () => {
  const gh = vi.fn(async () => {
    throw new Error("History reads must not fetch GitHub");
  });
  const app = buildApp({ store, config, bus: new ChangeBus(), gh });
  try {
    for (const query of [
      "repoId=removed-repo",
      "limit=0",
      "limit=51",
      "limit=2.5",
      "cursor=invalid",
      "repoId[]=sample",
    ]) {
      const response = await app.inject(`/api/qa/history?${query}`);
      // Unknown keys cannot widen configured scope; invalid named values fail validation.
      expect(response.statusCode).toBe(query.startsWith("repoId[]") ? 200 : 400);
    }
    const id = native(1, "removed-repo");
    for (const key of [String(id), "-1", "1e0", "9999999999999999999999"])
      expect((await app.inject(`/api/qa/history/native/${key}`)).statusCode).toBe(404);
    const response = await app.inject("/api/qa/history");
    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toEqual([]);
    expect(gh).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it("returns lightweight public metadata only; native detail stays scoped while assets keep existing auth", async () => {
  const id = native(1);
  store.putQaReport(report(1));
  const app = buildApp({ store, config, bus: new ChangeBus(), operatorToken: "fixture-operator" });
  try {
    const page = (await app.inject("/api/qa/history?limit=1&repoId=sample")).json();
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain("summary");
    expect(JSON.stringify(page)).not.toContain("/api/qa-report-assets/");
    const detail = await app.inject(`/api/qa/history/native/${id}?identity=${identity(id)}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().review.sha).toBe(nativeHead(1));
    expect((await app.inject(`/api/qa-report-assets/${"c".repeat(64)}`)).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});
const nativeHead = (n: number) => n.toString(16).padStart(40, "b");

it("does not hide a different native identity that reuses a pruned review id", () => {
  const id = native(1);
  store.putQaReport(
    report(1, {
      nativeReviewId: id,
      source: "native",
      prNumber: 8,
      headSha: nativeHead(1),
      reviewer: { id: "retro-1", label: "retro-1" },
      nativeRunId: "review-1",
    }),
  );
  const originalIdentity = identity(id);
  const db = new DatabaseSync(store.path);
  db.prepare("UPDATE reviews SET sha = ?, seat_id = ?, run_id = ? WHERE id = ?").run(
    "f".repeat(40),
    "retro-new",
    "new-run",
    id,
  );
  db.close();
  const entries = qaHistoryPage(store, config, {})?.entries ?? [];
  expect(entries).toHaveLength(2);
  expect(qaNativeHistory(store, config, id, originalIdentity)).toBeNull();
  expect(entries.find((e) => e.kind === "native")).toMatchObject({
    headSha: "f".repeat(40),
    reviewer: { id: "retro-new" },
  });
});

it("retains original resolutions and separates bound command receipts from reported test counts", () => {
  const prior = native(1),
    id = native(2);
  store.addCheckRun({
    runId: "review-2",
    command: "pnpm check",
    headSha: nativeHead(2),
    ok: true,
    exitCode: 0,
    at: 900,
  });
  store.addCheckRun({
    runId: "review-2",
    command: "wrong head check",
    headSha: "f".repeat(40),
    ok: true,
    at: 901,
  });
  const db = new DatabaseSync(store.path);
  db.prepare(
    "INSERT INTO test_lock_runs (run_id, seat_id, command, queued_at, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("review-2", "retro-2", "focused tool command", 700, 710, 800, "pass");
  db.prepare(
    "INSERT INTO review_resolutions (review_id, prior_review_id, finding_pos, outcome) VALUES (?, ?, ?, ?)",
  ).run(id, prior, 0, "fixed");
  db.close();
  const value = qaNativeHistory(store, config, id, identity(id));
  expect(value?.receipts).toHaveLength(2);
  expect(value?.receipts.find((r) => r.command === "pnpm check")).toMatchObject({
    origin: "hub-receipt",
    outcome: "passed",
    exitCode: 0,
    at: 900,
  });
  const lock = value?.receipts.find((r) => r.command === "focused tool command");
  expect(lock).toMatchObject({
    origin: "hub-receipt",
    outcome: "unknown",
    exitCode: null,
    at: 800,
  });
  expect(lock?.evidence).toContain("scratch source cleanliness were not recorded");
  expect(value?.tests[0]).toMatchObject({ passed: 3, failed: 1 });
  expect(value?.resolutions).toEqual([
    { findingRef: { reviewId: prior, pos: 0 }, outcome: "fixed" },
  ]);
  expect(store.qaReports("sample", 8)).toEqual([]);
});
