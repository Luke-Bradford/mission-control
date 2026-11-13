import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CODE_HEALTH_RULES } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileContext, declaredTicketFiles } from "../src/code-health/file-context.ts";
import { CodeHealthReader } from "../src/code-health/read.ts";
import { RecommendationMutation } from "../src/code-health/recommendations.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  DAY = 86400000,
  SECRET = `literal-fixture-${"z".repeat(48)}`;
const sha = (n: number) => n.toString(16).padStart(40, "0"),
  checkout = "/fixture/checkouts/sample";
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  repos: ["sample", "other"].map((id) => ({
    id,
    github: `example/${id}`,
    project: 1,
    statusMap: { Todo: "planned" },
    autonomy: "draft",
    runCommand: "pnpm dev",
  })),
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/fixture/worktrees",
    maxSeats: 4,
    sessions: [{ id: "sample", repoId: "sample", checkout, seats: [] }],
  },
};
describe("file triage and declared-ticket context", () => {
  let root: string, store: Store, db: DatabaseSync;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-file-context-"));
    const path = join(root, "fixture.sqlite");
    store = new Store(path);
    db = new DatabaseSync(path);
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function seed(files = [{ path: "src/example.ts", lines: 1000 }], touches = 5, version = 1) {
    store.recordCodeHealthSizeSnapshot(
      "sample",
      checkout,
      { version: 1, analysedSha: sha(9000 + version), files, elapsedMs: 1, excludedBinaryFiles: 0 },
      NOW - 1000,
    );
    for (let n = 1; n <= touches; n++) {
      db.prepare(
        "INSERT OR REPLACE INTO pr_history(repo_id,number,merged_at,record)VALUES('sample',?,?,?)",
      ).run(n, NOW - n * DAY, JSON.stringify({ mergeCommitSha: sha(1000 + n) }));
      store.recordCodeHealthMembership({
        repoId: "sample",
        pr: n,
        sha: sha(1000 + n),
        kind: "git-merge",
        files: files.map((file) => file.path),
        declaredFiles: files.length,
        at: NOW - 1000,
      });
    }
  }
  function fileRow() {
    store.refreshCodeHealthRecommendations("sample", NOW, checkout);
    const row = store
      .codeHealthRecommendations("sample")
      .find((row) => row.rule === "repeatedly-changed-large-file");
    if (!row) throw Error("Missing file proposal");
    return row;
  }
  it("requires both measured size and complete dated touches, with stable identity and scoped evidence", () => {
    seed([{ path: "src/example.ts", lines: 1000 }], 4);
    store.refreshCodeHealthRecommendations("sample", NOW, checkout);
    expect(
      store
        .codeHealthRecommendations("sample")
        .some((row) => row.rule === "repeatedly-changed-large-file"),
    ).toBe(false);
    seed([{ path: "src/example.ts", lines: 999 }], 5, 3);
    store.refreshCodeHealthRecommendations("sample", NOW, checkout);
    expect(
      store
        .codeHealthRecommendations("sample")
        .some((row) => row.rule === "repeatedly-changed-large-file"),
    ).toBe(false);
    seed([{ path: "src/example.ts", lines: 1000 }], 5);
    const first = fileRow();
    expect(first.target).toMatchObject({
      baseline: 1000,
      metric: "measured regular-text lines in this file",
    });
    expect(first.target).toMatchObject({
      value: CODE_HEALTH_RULES.repeatedlyChangedLargeFile.lines,
      source: "CODE_HEALTH_RULES.repeatedlyChangedLargeFile.lines",
    });
    expect(first.measure).toMatchObject({ current: 1000, unit: "lines" });
    expect(first.decision).toEqual({ owner: "FLIGHT", tier: "flight" });
    expect(first.title).toContain("src/example.ts");
    expect(first.title).toContain("1000 lines now");
    expect(first.causeId).toBe(fileRow().causeId);
    expect(first.scope).toMatchObject({
      kind: "file-risk",
      file: "src/example.ts",
      sizeSha: sha(9001),
      from: NOW - 30 * DAY,
      until: NOW,
    });
    expect(fileRow().id).toBe(first.id);
    const reader = new CodeHealthReader(store, config, () => NOW),
      row = reader.recommendation("sample", first.id);
    expect(reader.evidence("sample", row.evidence[0].id, undefined).rows).toEqual([
      { path: "src/example.ts", lines: 1000 },
    ]);
    expect(reader.evidence("sample", row.evidence[1].id, undefined).rows).toHaveLength(5);
    expect(() => reader.evidence("other", row.evidence[0].id, undefined)).toThrow(/unavailable/);
    db.prepare("DELETE FROM code_health_file_memberships WHERE pr_number=5").run();
    store.refreshCodeHealthRecommendations("sample", NOW + 1, checkout);
    expect(store.codeHealthRecommendation("sample", first.id)?.active).toBe(false);
  });
  it("projects a busy repo as distinct causes with numeric now and target pairs", () => {
    seed(
      [
        { path: "src/store.ts", lines: 4200 },
        { path: "src/api.ts", lines: 1800 },
      ],
      5,
    );
    const causes: [string, string, string][] = [
      ["correctness", "Null input crashes the parser", "Guard the null case before parsing"],
      ["security", "Token is logged in plain text", "Redact the token before logging"],
      ["spec", "Retry window differs from the spec", "Use the 7 day retry window"],
      ["test-missing", "No test covers the empty queue", "Add an empty-queue regression test"],
      ["scope", "Change edits an unrelated guard", "Revert the guard change"],
    ];
    const review = db.prepare(
      "INSERT INTO reviews(id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)VALUES(?,?,'sample','reviewer',?,?,0,1,?,'reported',?,?)",
    );
    const finding = db.prepare(
      "INSERT INTO review_findings(review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,category,state)VALUES(?,?,?,'Important',?,1,?,'s',?,?,'open')",
    );
    causes.forEach(([category, summary, fix], i) => {
      for (const [k, pr] of [100 + i * 2, 101 + i * 2].entries()) {
        const id = 1000 + pr;
        review.run(id, `run-${id}`, pr, sha(7000 + pr), 1, NOW - DAY, NOW - DAY);
        for (let pos = 0; pos < 2; pos++)
          finding.run(
            id,
            `run-${id}`,
            pos,
            `src/area-${i}/${k ? "b" : "a"}.ts`,
            summary,
            fix,
            category,
          );
        store.upsertPullRequests(
          "sample",
          [
            {
              repoId: "sample",
              number: pr,
              title: `PR ${pr}`,
              url: `https://github.com/example/sample/pull/${pr}`,
              branch: `fixture/${pr}`,
              base: "main",
              ticket: null,
              state: "open",
              isDraft: false,
              review: null,
              ci: "passing",
              createdAt: NOW - DAY,
              updatedAt: NOW,
              mergedAt: null,
              headSha: sha(7000 + pr),
              mergeable: null,
            } as never,
          ],
          NOW,
        );
      }
    });
    review.run(2900, "run-2900", 300, sha(8300), 3, NOW - DAY, NOW - DAY);

    store.refreshCodeHealthRecommendations("sample", NOW, checkout);

    const rows = store.codeHealthRecommendations("sample");
    expect(new Set(rows.map((row) => row.causeId)).size).toBe(rows.length);
    expect(rows.filter((row) => row.rule === "recurring-correction")).toHaveLength(5);
    expect(rows.filter((row) => row.rule === "repeatedly-changed-large-file")).toHaveLength(2);
    expect(rows.some((row) => row.rule === "repeated-rounds")).toBe(true);
    expect(rows.some((row) => row.rule === "collection")).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const measured = rows.filter(
      (row) => typeof row.measure?.current === "number" && typeof row.target.value === "number",
    );
    expect(measured.length).toBeGreaterThanOrEqual(5);
    for (const row of measured) {
      expect(row.title).toBeTruthy();
      expect(row.decision).toBeTruthy();
    }
  });
  it("keeps an accepted measured baseline when new observations change the proposal", () => {
    seed();
    const first = fileRow();
    const request = RecommendationMutation.parse({
      requestId: randomUUID(),
      basis: "Inspect measured file evidence",
      expectedUpdatedAt: first.updatedAt,
      change: { action: "accept", owner: "owner", reviewAt: NOW + DAY },
    });
    store.decideCodeHealthRecommendation("sample", first.id, request, "operator", NOW + 1);
    seed([{ path: "src/example.ts", lines: 1500 }], 5, 2);
    store.refreshCodeHealthRecommendations("sample", NOW + 2, checkout);
    const changed = store.codeHealthRecommendation("sample", first.id);
    expect(changed?.state.kind).toBe("accepted");
    expect(changed?.baseline?.target.baseline).toBe(1000);
    expect(changed?.target.baseline).toBe(1500);
    expect(changed?.baseline?.scope?.sizeSha).toBe(sha(9001));
  });
  it("takes explicit file sections while excluding examples, references, escapes and globs", () => {
    const body = [
      "## References",
      "- `src/reference.ts`",
      "```md",
      "## Files",
      "- `src/example-only.ts`",
      "```",
      "<!--",
      "## Files",
      "- `src/comment.ts`",
      "-->",
      "## File scope",
      "- `src/target.ts` — modify",
      "- src/created.ts (new)",
      "- `../escape.ts`",
      "- `/private/file.ts`",
      "- `src/**`",
      "## References",
      "- `src/later.ts`",
    ].join("\n");
    expect(declaredTicketFiles(body)).toEqual(["src/target.ts", "src/created.ts"]);
    expect(declaredTicketFiles("Change `src/reference.ts` in area:web.")).toEqual([]);
    expect(declaredTicketFiles("## Files\n- `apps/**`\n- `C:/outside.ts`")).toEqual([]);
  });
  it("returns at most three relevant proposals and makes no context from unrelated scope", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      lines: 1000 + i * 100,
    }));
    seed(files);
    const knownSecrets = vi.fn(async () => []),
      context = createFileContext({ config, store, knownSecrets, now: () => NOW });
    expect(await context("sample", "## References\n- `src/file-4.ts`")).toBeNull();
    expect(knownSecrets).not.toHaveBeenCalled();
    const body =
      "## Files\n" +
      files
        .slice(0, 4)
        .map((file) => `- \`${file.path}\``)
        .join("\n");
    const value = await context("sample", body);
    if (!value) throw Error("Missing context");
    const rows = JSON.parse(value) as { file: string }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => files.slice(0, 4).some((file) => file.path === row.file))).toBe(
      true,
    );
    expect(value).not.toContain("src/file-4.ts");
    expect(await context("other", body)).toBeNull();
    expect(await context("missing", body)).toBeNull();
  });
  it("redacts known literals and omits optional context if secret lookup fails or times out", async () => {
    seed();
    for (const [id, pr] of [
      [1, 1],
      [2, 2],
    ])
      db.prepare(
        "INSERT INTO reviews(id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)VALUES(?,?,'sample','reviewer',?,?,0,1,1,'reported',?,?)",
      ).run(id, `run-${id}`, pr, sha(pr), NOW - 1000, NOW - 1000);
    for (let n = 0; n < 3; n++)
      db.prepare(
        "INSERT INTO review_findings(review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,category,state)VALUES(?,? ,?,'Minor','src/example.ts',1,'Example','Example','Example',?,'open')",
      ).run(n === 2 ? 2 : 1, n === 2 ? "run-2" : "run-1", n, SECRET);
    const body = "## Files\n- `src/example.ts`",
      ok = createFileContext({ config, store, knownSecrets: async () => [SECRET], now: () => NOW });
    const text = await ok("sample", body);
    expect(text).not.toBeNull();
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[redacted]");
    expect(
      await createFileContext({
        config,
        store,
        knownSecrets: async () => {
          throw Error("fixture");
        },
        now: () => NOW,
      })("sample", body),
    ).toBeNull();
    expect(
      await createFileContext({
        config,
        store,
        knownSecrets: () => new Promise(() => {}),
        secretsTimeoutMs: 10,
        now: () => NOW,
      })("sample", body),
    ).toBeNull();
  });
  it("names evicted size evidence instead of presenting an empty historical baseline", () => {
    seed();
    const first = fileRow(),
      reader = new CodeHealthReader(store, config, () => NOW);
    db.prepare("DELETE FROM code_health_file_sizes WHERE sha=?").run(sha(9001));
    db.prepare("DELETE FROM code_health_size_snapshots WHERE sha=?").run(sha(9001));
    const ref = reader.recommendation("sample", first.id).evidence[0];
    expect(() => reader.evidence("sample", ref.id, undefined)).toThrow(/no longer retained/);
  });
});
