import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeHealthReadError } from "../src/code-health/error.ts";
import { installTestQa, linkTestQa, readTestQa } from "../src/code-health/test-qa.ts";
import { importTestReport, installTestReports } from "../src/code-health/test-reports.ts";

const NOW = Date.UTC(2026, 10, 2),
  SHA = "a".repeat(40);
const SECRET = `fixture-${"z".repeat(40)}`;
describe("evidence-backed test QA proposals", () => {
  let db: DatabaseSync, testId: string;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    installTestReports(db);
    installTestQa(db);
    db.exec(`CREATE TABLE reviews(id INTEGER PRIMARY KEY,repo_id TEXT,sha TEXT,state TEXT,seat_id TEXT);
      CREATE TABLE review_findings(review_id INTEGER,pos INTEGER,file TEXT,line INTEGER,summary TEXT,scenario TEXT,fix TEXT,category TEXT);
      INSERT INTO reviews VALUES(1,'sample','${SHA}','reported','RETRO-CX');
      INSERT INTO review_findings VALUES(1,0,'test/example.test.ts',12,
        'The assertion still expects the removed fallback.',
        'The current specification requires rejecting empty input; this test expects success.',
        'Replace the success assertion with the documented validation error.', 'test-stale');`);
    importTestReport(
      db,
      {
        version: 1,
        repo: "sample",
        headSha: SHA,
        workflow: "CI",
        workflowRun: "1",
        job: "unit",
        jobRun: "2",
        runAttempt: 1,
        environment: "node-linux",
        completedAt: NOW - 1,
        expectedAttempts: 1,
        cases: [
          {
            testId: "example",
            file: "test/example.test.ts",
            suite: "validation",
            name: "empty input",
            attemptId: "example:1",
            executionOrder: 1,
            state: "passed",
            completedAt: NOW - 2,
            duration: 10,
            durationUnit: "ms",
          },
        ],
      },
      "operator",
      NOW,
      [],
    );
    testId = db.prepare("SELECT test_id FROM code_health_test_attempts").get()?.test_id as string;
  });
  afterEach(() => db.close());
  const input = () => ({
    repo: "sample",
    testId,
    headSha: SHA,
    reviewId: 1,
    findingPosition: 0,
    judgement: "stale",
    specEvidence:
      "The validation specification requires empty input to return an error; the test still expects success.",
  });
  const link = (patch = {}, actor = "operator", at = NOW) =>
    linkTestQa(db, { ...input(), ...patch }, actor, at, []);
  const read = () => readTestQa(db, "sample", NOW - 1000, NOW + 1);
  it("records actual review identity, explicit operator linkage and immutable code/spec evidence", () => {
    const result = link();
    expect(result).toMatchObject({ reused: false });
    expect(read()).toMatchObject({ complete: true, truncated: false });
    expect(read().rows).toHaveLength(1);
    expect(read().rows[0]).toMatchObject({
      id: result.id,
      repo_id: "sample",
      test_id: testId,
      head_sha: SHA,
      judgement: "stale",
      reviewer: "RETRO-CX",
      review_id: 1,
      finding_position: 0,
      at: NOW,
      actor: "operator",
      file: "test/example.test.ts",
      line: 12,
      spec_evidence: input().specEvidence,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_health_test_attempts").get()?.n).toBe(1);
    db.exec("DELETE FROM reviews; DELETE FROM review_findings");
    expect(read().rows).toHaveLength(1);
  });
  it("rejects spoofed reviewer identity and unrecognised proposal inputs", () => {
    expect(() => link({ reviewer: "operator-pretending-to-review" })).toThrow(/Invalid test QA/);
    expect(() => link({ ageDays: 3000 })).toThrow(/Invalid test QA/);
    expect(() => link({ url: "https://example.test/proof" })).toThrow(/Invalid test QA/);
    expect(read().rows).toHaveLength(0);
  });
  it.each([
    { repo: "other" },
    { testId: "f".repeat(64) },
    { headSha: "b".repeat(40) },
    { testId: "example" },
    { headSha: "abc" },
    { reviewId: 999 },
    { findingPosition: 1 },
  ])("rejects absent or mismatched test and review identities: %j", (patch) => {
    expect(() => link(patch)).toThrow(CodeHealthReadError);
    expect(read().rows).toHaveLength(0);
  });
  it.each([
    "UPDATE reviews SET state='running'",
    "UPDATE reviews SET repo_id='other'",
    `UPDATE reviews SET sha='${"b".repeat(40)}'`,
    "UPDATE review_findings SET file='test/other.test.ts'",
    "UPDATE review_findings SET line=0",
    "UPDATE review_findings SET scenario=''",
    "UPDATE review_findings SET fix='unknown'",
    "UPDATE review_findings SET category='bug'",
    "UPDATE review_findings SET file='../escape.test.ts'",
  ])("requires meaningful reported source evidence with exact scope: %s", (change) => {
    db.exec(change);
    expect(() => link()).toThrow(CodeHealthReadError);
    expect(read().rows).toHaveLength(0);
  });
  it("rejects empty, placeholder and age-only proof without deriving staleness from age", () => {
    for (const specEvidence of [
      "",
      "   ",
      "not applicable",
      "The only evidence is its age.",
      "This test is 3 years old.",
    ])
      expect(() => link({ specEvidence })).toThrow(CodeHealthReadError);
    // Old review dates and old test results are not inputs to the judgement.
    expect(link()).toMatchObject({ reused: false });
  });
  it("does not mistake a statement rejecting age-based judgement for age-only evidence", () => {
    expect(
      link({
        specEvidence:
          "Age alone does not prove staleness. The specification requires an error where this test expects success.",
      }),
    ).toMatchObject({ reused: false });
  });
  it("rejects file matches created only by redaction", () => {
    db.prepare("UPDATE code_health_test_attempts SET file=?").run("test/[redacted].test.ts");
    db.prepare("UPDATE review_findings SET file=?").run(`test/${SECRET}.test.ts`);
    expect(() => linkTestQa(db, input(), "operator", NOW, [SECRET])).toThrow(
      /requires matching test code/,
    );
  });
  it("requires the correct source category for wrong, slow and flaky classifications", () => {
    for (const judgement of ["wrong", "slow", "flaky"])
      expect(() => link({ judgement })).toThrow(/requires matching test code/);
    db.exec("UPDATE review_findings SET category='test-wrong'");
    for (const judgement of ["wrong", "slow", "flaky"])
      expect(link({ judgement })).toMatchObject({ reused: false });
    expect(
      read()
        .rows.map((row) => row.judgement)
        .sort(),
    ).toEqual(["flaky", "slow", "wrong"]);
    expect(() => link()).toThrow(/requires matching test code/);
  });
  it("reuses identical links, preserves first actor/time, and rejects changed proof with 409", () => {
    const first = link();
    expect(link({}, "second-operator", NOW + 1)).toEqual({ ...first, reused: true });
    expect(read().rows[0]).toMatchObject({ actor: "operator", at: NOW });
    try {
      link({
        specEvidence: "The specification now requires another documented outcome for empty input.",
      });
      expect.fail("Expected immutable evidence conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CodeHealthReadError);
      expect((error as CodeHealthReadError).status).toBe(409);
    }
    db.exec(
      "UPDATE review_findings SET fix='A different proposed correction changes source evidence.'",
    );
    expect(() => link()).toThrow(/already has different evidence/);
    expect(read().rows).toHaveLength(1);
  });
  it("redacts all persisted untrusted labels, actor and proof while retaining actual source provenance", () => {
    db.prepare("UPDATE reviews SET seat_id=?").run(`RETRO ${SECRET}`);
    db.prepare("UPDATE review_findings SET summary=?,scenario=?,fix=?").run(
      `The assertion contains ${SECRET}`,
      `The documented behaviour differs: ${SECRET}`,
      `Correct the expectation: ${SECRET}`,
    );
    linkTestQa(
      db,
      { ...input(), specEvidence: `The specification requires a validation error: ${SECRET}` },
      `operator ${SECRET}`,
      NOW,
      [SECRET],
    );
    const stored = JSON.stringify(db.prepare("SELECT * FROM code_health_test_qa").all());
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("[redacted]");
    expect(read().rows[0].reviewer).toBe("RETRO [redacted]");
  });
  it.each(["summary", "scenario", "fix", "specEvidence"])(
    "rejects evidence consisting entirely of redacted secrets: %s",
    (field) => {
      const proposal = input();
      if (field === "specEvidence") proposal.specEvidence = SECRET;
      else db.prepare(`UPDATE review_findings SET ${field}=?`).run(SECRET);
      expect(() => linkTestQa(db, proposal, "operator", NOW, [SECRET])).toThrow(
        /requires matching test code/,
      );
      expect(read().rows).toHaveLength(0);
    },
  );
  it("rejects literal or repeated redaction placeholders as proof", () => {
    for (const specEvidence of ["[redacted]", "[redacted] [redacted]."])
      expect(() => link({ specEvidence })).toThrow(/Invalid test QA/);
  });
  it("refuses unbounded, invalid and cyclic inputs", () => {
    expect(() => link({ specEvidence: "x".repeat(16385) })).toThrow(/16 KiB/);
    expect(() => link({ specEvidence: "x".repeat(2001) })).toThrow(/Invalid test QA/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => linkTestQa(db, cyclic, "operator", NOW, [])).toThrow(/Invalid test QA/);
    expect(() => link({}, "", NOW)).toThrow(/Invalid test QA/);
    expect(() => link({}, "operator", Number.NaN)).toThrow(/Invalid test QA/);
  });
  it("uses a half-open window and isolates repository history", () => {
    link();
    expect(readTestQa(db, "sample", NOW, NOW + 1).rows).toHaveLength(1);
    expect(readTestQa(db, "sample", NOW - 1, NOW).rows).toHaveLength(0);
    expect(readTestQa(db, "other", NOW - 1, NOW + 1).rows).toHaveLength(0);
  });
  it("bounds raw retrieval with a sentinel and marks truncated collection incomplete", () => {
    link();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO code_health_test_qa SELECT repo_id,'fixture-'||n.i,fingerprint,test_id,head_sha,
      judgement,reviewer,review_id,finding_position,at,actor,file,line,summary,scenario,fix,spec_evidence
      FROM code_health_test_qa,n WHERE id LIKE 'ctq_%'`);
    expect(read()).toMatchObject({ complete: false, truncated: true });
    expect(read().rows).toHaveLength(20000);
  });
});
