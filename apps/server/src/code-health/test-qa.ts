/** Links existing review evidence to an observed test; never starts QA or changes test execution. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { cleanCodeHealth } from "./clean.ts";
import { CodeHealthReadError } from "./error.ts";
import { riskPath } from "./risk.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
const hex = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[a-f0-9]{${length}}$`, "i"))
    .transform((s) => s.toLowerCase());
const proof = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .refine(
    (s) =>
      !/^(?:n\/?a|none|unknown|todo|tbd|not applicable|no evidence|age only)[.!\s]*$/i.test(s) &&
      !/^(?:\[redacted\][.!\s]*)+$/i.test(s),
  );
export const TestQaProposal = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  testId: hex(64),
  headSha: hex(40),
  reviewId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  findingPosition: z.number().int().min(0).max(1000000),
  judgement: z.enum(["stale", "wrong", "slow", "flaky"]),
  /** Relevant specification/behaviour and why the proposed correction follows from it. */
  specEvidence: proof,
});

export type TestQaRow = {
  repo_id: string;
  id: string;
  test_id: string;
  head_sha: string;
  judgement: z.infer<typeof TestQaProposal>["judgement"];
  reviewer: string;
  review_id: number;
  finding_position: number;
  at: number;
  actor: string;
  file: string;
  line: number;
  summary: string;
  scenario: string;
  fix: string;
  spec_evidence: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function installTestQa(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_test_qa (
    repo_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    test_id TEXT NOT NULL, head_sha TEXT NOT NULL, judgement TEXT NOT NULL,
    reviewer TEXT NOT NULL, review_id INTEGER NOT NULL, finding_position INTEGER NOT NULL,
    at INTEGER NOT NULL, actor TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL,
    summary TEXT NOT NULL, scenario TEXT NOT NULL, fix TEXT NOT NULL, spec_evidence TEXT NOT NULL,
    PRIMARY KEY(repo_id,id)
  );
  CREATE INDEX IF NOT EXISTS code_health_test_qa_window ON code_health_test_qa(repo_id,at,id);`);
}

/** Caller supplies authenticated actor/scope and wraps the link in a Store transaction. */
export function linkTestQa(
  db: Db,
  raw: unknown,
  actor: string,
  at: number,
  knownSecrets: readonly string[],
) {
  let encoded: string;
  try {
    encoded = JSON.stringify(raw) ?? "";
  } catch {
    throw new CodeHealthReadError(400, "Invalid test QA proposal.");
  }
  if (Buffer.byteLength(encoded) > 16384)
    throw new CodeHealthReadError(413, "Test QA proposal exceeds the 16 KiB limit.");
  const parsed = TestQaProposal.safeParse(raw);
  if (
    !parsed.success ||
    !z.string().trim().min(1).max(200).safeParse(actor).success ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    at > 8640000000000000
  )
    throw new CodeHealthReadError(400, "Invalid test QA proposal.");
  const input = parsed.data;
  // Scope keys must retain their exact identity after cleaning; never persist a secret scope key.
  for (const key of [input.repo, input.testId, input.headSha]) {
    if (cleanCodeHealth(key, knownSecrets) !== key)
      throw new CodeHealthReadError(400, "Test QA scope contains unsafe identity text.");
  }
  const attempt = db
    .prepare(`SELECT a.file FROM code_health_test_attempts a
    JOIN code_health_test_reports r ON r.repo_id=a.repo_id AND r.id=a.report_id
    WHERE a.repo_id=? AND a.test_id=? AND r.head_sha=? LIMIT 1`)
    .get(input.repo, input.testId, input.headSha);
  if (!attempt)
    throw new CodeHealthReadError(
      400,
      "Test QA requires an imported test at this repository and head.",
    );
  const source = db
    .prepare(`SELECT v.repo_id,v.sha,v.state,v.seat_id,
    f.file,f.line,f.summary,f.scenario,f.fix,f.category
    FROM reviews v JOIN review_findings f ON f.review_id=v.id
    WHERE v.id=? AND f.pos=?`)
    .get(input.reviewId, input.findingPosition);
  if (source?.state !== "reported" || source.repo_id !== input.repo || source.sha !== input.headSha)
    throw new CodeHealthReadError(
      400,
      "Test QA requires a reported review at this repository and head.",
    );
  const clean = cleanCodeHealth(
    {
      reviewer: source.seat_id,
      actor,
      file: source.file,
      line: source.line,
      summary: source.summary,
      scenario: source.scenario,
      fix: source.fix,
      specEvidence: input.specEvidence,
    },
    knownSecrets,
  ) as {
    reviewer: string;
    actor: string;
    file: string;
    line: number;
    summary: string;
    scenario: string;
    fix: string;
    specEvidence: string;
  };
  const category = input.judgement === "stale" ? "test-stale" : "test-wrong";
  if (
    source.category !== category ||
    source.file !== attempt.file ||
    !riskPath(clean.file) ||
    clean.file !== attempt.file ||
    !Number.isSafeInteger(clean.line) ||
    clean.line < 1 ||
    !clean.reviewer.trim() ||
    !clean.actor.trim() ||
    ![clean.summary, clean.scenario, clean.fix, clean.specEvidence].every(
      (s) => proof.safeParse(s).success,
    )
  )
    throw new CodeHealthReadError(
      400,
      "Test QA requires matching test code, scenario, correction and specification evidence.",
    );
  // Dates never establish staleness. An explicit claim that age is the sole proof is not evidence.
  if (
    input.judgement === "stale" &&
    /^(?:(?:this )?(?:test )?(?:is )?(?:\d+|many|several) years? old|(?:the )?(?:only|sole) (?:evidence|reason|proof) is (?:its |the test.s? )?age|age alone(?: proves (?:it is |the test is )?stale)?|age[- ]only(?: evidence)?)[.!\s]*$/i.test(
      clean.specEvidence,
    )
  )
    throw new CodeHealthReadError(
      400,
      "Test age alone does not establish staleness; supply code and specification evidence.",
    );
  const id = `ctq_${hash([input.repo, input.testId, input.headSha, input.reviewId, input.findingPosition, input.judgement])}`;
  const fingerprint = hash([
    input,
    source.seat_id,
    source.file,
    source.line,
    source.summary,
    source.scenario,
    source.fix,
  ]);
  const previous = db
    .prepare("SELECT fingerprint FROM code_health_test_qa WHERE repo_id=? AND id=?")
    .get(input.repo, id);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new CodeHealthReadError(409, "This test QA identity already has different evidence.");
    return { id, reused: true };
  }
  db.prepare("INSERT INTO code_health_test_qa VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    input.repo,
    id,
    fingerprint,
    input.testId,
    input.headSha,
    input.judgement,
    clean.reviewer,
    input.reviewId,
    input.findingPosition,
    at,
    clean.actor,
    clean.file,
    clean.line,
    clean.summary,
    clean.scenario,
    clean.fix,
    clean.specEvidence,
  );
  return { id, reused: false };
}

/** Half-open collection window, preserving proposals independently of source-review retention. */
export function readTestQa(db: Db, repoId: string, from: number, until: number) {
  const rows = db
    .prepare(`SELECT repo_id,id,test_id,head_sha,judgement,reviewer,review_id,
    finding_position,at,actor,file,line,summary,scenario,fix,spec_evidence
    FROM code_health_test_qa WHERE repo_id=? AND at>=? AND at<? ORDER BY at,id LIMIT 20001`)
    .all(repoId, from, until) as TestQaRow[];
  return {
    rows: rows.slice(0, 20000),
    complete: rows.length <= 20000,
    truncated: rows.length > 20000,
  };
}
