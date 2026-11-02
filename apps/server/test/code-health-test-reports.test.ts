import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveTestHealth } from "../src/code-health/test-model.ts";
import type { TestReportInput } from "../src/code-health/test-reports.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  SHA = "a".repeat(40),
  SECRET = `fictional-${"x".repeat(40)}`;
function report(patch: Partial<TestReportInput> = {}): TestReportInput {
  return {
    version: 1,
    repo: "sample",
    headSha: SHA,
    workflow: "CI",
    workflowRun: "101",
    job: "unit",
    jobRun: "201",
    runAttempt: 1,
    environment: "linux-node25",
    completedAt: NOW - 1,
    expectedAttempts: 1,
    cause: "unknown",
    causeEvidence: "",
    cases: [
      {
        testId: "test-a",
        file: "test/example.test.ts",
        suite: "example",
        name: "does the work",
        attemptId: "test-a:1",
        executionOrder: 1,
        state: "passed",
        completedAt: NOW - 2,
        duration: 1.5,
        durationUnit: "s",
      },
    ],
    ...patch,
  };
}
describe("bounded immutable test-report ingestion", () => {
  let root: string, store: Store, db: DatabaseSync, path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-test-report-"));
    path = join(root, "fixture.sqlite");
    store = new Store(path);
    db = new DatabaseSync(path);
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const read = () => store.codeHealthTestAttempts("sample", NOW - 1000, NOW);
  const ingest = (value: unknown) => store.importCodeHealthTestReport(value, "operator", NOW, []);
  it("persists one actual attempt, normalises documented seconds and deduplicates a replay", () => {
    const first = ingest(report()),
      revision = store.codeHealthRevision("sample");
    expect(first).toMatchObject({ attempts: 1, reused: false });
    expect(ingest(report())).toEqual({ ...first, reused: true });
    expect(store.codeHealthRevision("sample")).toBe(revision);
    expect(read()).toMatchObject({ reports: 1, complete: true, truncated: false });
    expect(read().rows).toHaveLength(1);
    expect(read().rows[0]).toMatchObject({
      state: "passed",
      duration: 1.5,
      duration_unit: "s",
      duration_ms: 1500,
      head_sha: SHA,
      workflow_run: "101",
      job_run: "201",
      run_attempt: 1,
      execution_order: 1,
      actor: "operator",
    });
  });
  it("retains skipped, cancelled and not-run cases without manufacturing executed durations", () => {
    const value = report();
    value.cases = ["passed", "failed", "skipped", "cancelled", "not-run"].map((state, i) => ({
      ...value.cases[0],
      testId: `test-${i}`,
      attemptId: `test-${i}:1`,
      state: state as TestReportInput["cases"][number]["state"],
    }));
    value.expectedAttempts = 5;
    ingest(value);
    expect(
      read()
        .rows.map((row) => row.state)
        .sort(),
    ).toEqual(["cancelled", "failed", "not-run", "passed", "skipped"]);
    expect(read().rows.filter((row) => row.duration_ms !== null)).toHaveLength(2);
  });
  it.each([{ durationUnit: null }, { duration: null }, { environment: null }])(
    "keeps undocumented duration or environment unknown: %j",
    (patch) => {
      const value = report();
      if ("environment" in patch) value.environment = patch.environment ?? null;
      else Object.assign(value.cases[0], patch);
      ingest(value);
      expect(read().rows[0].duration_ms).toBeNull();
    },
  );
  it("keeps partial collection explicit even when some executed results exist", () => {
    ingest(report({ expectedAttempts: null }));
    expect(read().complete).toBe(false);
  });
  it("retains raw attempts beyond the reader bound and withholds a truncated rate", () => {
    for (let batch = 0; batch < 11; batch++) {
      const value = report({ workflowRun: String(101 + batch), jobRun: String(201 + batch) });
      value.cases = Array.from({ length: batch === 10 ? 1 : 2000 }, (_, index) => ({
        ...value.cases[0],
        testId: `bounded-${batch}-${index}`,
        attemptId: `bounded-${batch}-${index}:1`,
        state: "failed",
      }));
      value.expectedAttempts = value.cases.length;
      ingest(value);
    }
    const source = read();
    expect(source).toMatchObject({ reports: 11, complete: false, truncated: true });
    expect(source.rows).toHaveLength(20000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_health_test_attempts").get()?.n).toBe(20001);
    const health = deriveTestHealth("sample", source);
    expect(health.rate).toEqual({ numerator: 20000, denominator: 20000, percent: null });
    expect(health.disruption).toHaveLength(50);
    expect(health.durations).toHaveLength(50);
    expect(health.omittedDisruption).toBe(19950);
    expect(health.omittedDurations).toBe(19950);
    expect(store.codeHealthTestCollection("sample", NOW - 1000, NOW)).toEqual({
      reports: 11,
      partialReports: 0,
      hasAttempts: true,
      hasExecuted: true,
      unorderedExecuted: false,
    });
    expect(store.codeHealthTestCollection("other", NOW - 1000, NOW).hasAttempts).toBe(false);
    expect(store.codeHealthTestCollection("sample", NOW, NOW + 1000).reports).toBe(0);
  });
  it("refuses changed evidence under one immutable report identity", () => {
    ingest(report());
    expect(() => ingest(report({ headSha: "b".repeat(40) }))).toThrow(
      /already has different evidence/,
    );
    expect(read().rows).toHaveLength(1);
  });
  it("refuses duplicate attempt identities and conflicting stable identities at the same head", () => {
    const value = report();
    value.cases.push({ ...value.cases[0] });
    value.expectedAttempts = 2;
    expect(() => ingest(value)).toThrow(/must be unique/);
    const first = report();
    ingest(first);
    const second = report({ jobRun: "202" });
    second.cases[0].name = "Different test";
    expect(() => ingest(second)).toThrow(/changed its file or name/);
    expect(read().reports).toBe(1);
  });
  it("keeps explicit retry order and never infers execution order from array position", () => {
    const value = report();
    value.cases = [
      { ...value.cases[0], attemptId: "test-a:second", executionOrder: 2 },
      { ...value.cases[0], attemptId: "test-a:first", executionOrder: 1, state: "failed" },
      { ...value.cases[0], attemptId: "test-a:unknown", executionOrder: null },
    ];
    value.expectedAttempts = 3;
    ingest(value);
    expect(
      read()
        .rows.map((row) => row.execution_order)
        .sort(),
    ).toEqual([1, 2, null]);
  });
  it("deduplicates reordered transport rows and explicitly supplied default metadata", () => {
    const value = report();
    value.cases.push({
      ...value.cases[0],
      attemptId: "test-a:2",
      executionOrder: 2,
      state: "failed",
    });
    value.expectedAttempts = 2;
    const first = ingest(value);
    value.cases.reverse();
    value.sourceFormat = "normalized-v1";
    value.collectionNote = "";
    expect(ingest(value)).toEqual({ ...first, reused: true });
    expect(read().rows).toHaveLength(2);
  });
  it("isolates repos and commits while permitting a stable test to move on a later commit", () => {
    ingest(report());
    ingest(report({ repo: "other" }));
    const later = report({ headSha: "b".repeat(40), workflowRun: "102", jobRun: "202" });
    later.cases[0].file = "test/renamed.test.ts";
    ingest(later);
    expect(read().rows).toHaveLength(2);
    expect(new Set(read().rows.map((row) => row.test_id)).size).toBe(1);
    expect(new Set(read().rows.map((row) => row.series_key)).size).toBe(2);
    expect(store.codeHealthTestAttempts("other", NOW - 1000, NOW).rows).toHaveLength(1);
    expect(store.codeHealthTestAttempts("missing", NOW - 1000, NOW).rows).toHaveLength(0);
  });
  it.each([
    "../escape.test.ts",
    "/workspace/private.test.ts",
    "https://example.test/report",
    "test/line\nfeed.ts",
  ])("rejects an unscoped path without reading files or URLs: %s", (file) => {
    const value = report();
    value.cases[0].file = file;
    expect(() => ingest(value)).toThrow(/Invalid version 1/);
    expect(read().reports).toBe(0);
  });
  it("refuses oversized, malformed, count-mismatched and future reports", () => {
    expect(() => ingest({ blob: "x".repeat(1024 * 1024) })).toThrow(/one MiB/);
    expect(() => ingest({ ...report(), url: "https://example.test/arbitrary" })).toThrow(
      /Invalid version 1/,
    );
    expect(() => ingest(report({ expectedAttempts: 2 }))).toThrow(/does not match/);
    expect(() => ingest(report({ completedAt: NOW + 300001 }))).toThrow(/completion time/);
    expect(() => ingest(report({ cause: "infrastructure" }))).toThrow(/requires source evidence/);
    const excess = report();
    excess.cases = Array.from({ length: 2001 }, (_, index) => ({
      ...excess.cases[0],
      attemptId: `too-many:${index}`,
    }));
    excess.expectedAttempts = excess.cases.length;
    expect(() => ingest(excess)).toThrow(/Invalid version 1/);
  });
  it("redacts secret-bearing labels while retaining hashed immutable identities", () => {
    const value = report({ workflow: SECRET, environment: SECRET });
    value.cases[0].name = SECRET;
    value.cases[0].testId = SECRET;
    value.cases[0].file = `test/${SECRET}.test.ts`;
    store.importCodeHealthTestReport(value, "operator", NOW, [SECRET]);
    expect(JSON.stringify(read())).not.toContain(SECRET);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);
  });
  it("rolls the complete import back if a later row cannot be stored", () => {
    db.exec(
      "CREATE TRIGGER fixture_abort BEFORE INSERT ON code_health_test_attempts WHEN NEW.name='stop' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    const value = report();
    value.cases.push({
      ...value.cases[0],
      name: "stop",
      testId: "other-test",
      attemptId: "other:1",
    });
    value.expectedAttempts = 2;
    expect(() => ingest(value)).toThrow(/fixture failure/);
    expect(read().rows).toHaveLength(0);
    expect(read().reports).toBe(0);
  });
});
