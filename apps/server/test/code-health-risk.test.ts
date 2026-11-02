import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodeHealthView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeHealthReader } from "../src/code-health/read.ts";
import {
  aggregateDatedRisk,
  datedPrFiles,
  reviewedFileMembership,
  riskFile,
  riskPath,
} from "../src/code-health/risk.ts";
import { codeHealthToolSummary } from "../src/code-health/tool-summary.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2);
const DAY = 86400000;
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
};

const sha = (n: number) => n.toString(16).padStart(40, "0");
describe("dated code-health file evidence", () => {
  let dir: string, store: Store, db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-code-risk-"));
    const file = join(dir, "fixture.sqlite");
    store = new Store(file);
    db = new DatabaseSync(file);
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function pr(n: number, at: number, repo = "sample") {
    db.prepare("INSERT INTO pr_history(repo_id,number,merged_at,record)VALUES(?,?,?,?)").run(
      repo,
      n,
      at,
      JSON.stringify({
        number: n,
        headSha: sha(n),
        mergeCommitSha: sha(n + 1000),
        changedFiles: 2,
      }),
    );
  }
  function files(
    n: number,
    paths: string[],
    kind: "github-head" | "git-merge" = "git-merge",
    repo = "sample",
    declared = paths.length,
  ) {
    store.recordCodeHealthMembership({
      repoId: repo,
      pr: n,
      sha: sha(kind === "git-merge" ? n + 1000 : n),
      kind,
      files: paths,
      declaredFiles: declared,
      at: 200,
    });
  }
  function review(id: number, n: number, head = sha(n), repo = "sample", at = 150) {
    db.prepare(
      `INSERT INTO reviews(id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)VALUES(?,?,?,'reviewer',?,?,0,1,1,'reported',?,?)`,
    ).run(id, `run-${id}`, repo, n, head, at, at);
  }
  it("uses a half-open merge window and repo scope", () => {
    for (const [n, at] of [
      [1, 100],
      [2, 199],
      [3, 200],
    ]) {
      pr(n, at);
      files(n, ["src/a.ts", "src/b.ts"]);
    }
    pr(4, 150, "other");
    files(4, ["src/other.ts"], "git-merge", "other");
    const source = datedPrFiles(db, "sample", 100, 200);
    expect(source.map((row) => row.pr)).toEqual([1, 2]);
    expect(source.every((row) => row.complete)).toBe(true);
    expect(aggregateDatedRisk(source).touches.get("src/a.ts")?.size).toBe(2);
  });
  it("does not infer head provenance from legacy rows or a matching file count", () => {
    pr(1, 150);
    db.prepare(
      "INSERT INTO pr_files(repo_id,pr_number,path,change_type)VALUES('sample',1,'src/a.ts','MODIFIED'),('sample',1,'src/b.ts','MODIFIED')",
    ).run();
    expect(datedPrFiles(db, "sample", 100, 200)[0]?.complete).toBe(false);
    store.recordCodeHealthMembership({
      repoId: "sample",
      pr: 1,
      sha: sha(999),
      kind: "github-head",
      files: ["src/a.ts", "src/b.ts"],
      declaredFiles: 2,
      at: 150,
    });
    expect(datedPrFiles(db, "sample", 100, 200)[0]?.complete).toBe(false);
    files(1, ["src/a.ts", "src/b.ts"], "github-head");
    expect(datedPrFiles(db, "sample", 100, 200)[0]?.complete).toBe(true);
  });
  it("prefers complete merge membership and preserves incomplete status", () => {
    pr(1, 150);
    files(1, ["src/old.ts"], "github-head", "sample", 2);
    const partial = aggregateDatedRisk(datedPrFiles(db, "sample", 100, 200));
    expect(partial.complete).toBe(false);
    expect(partial.couplingComplete).toBe(false);
    files(1, ["src/a.ts", "src/b.ts"]);
    const merged = datedPrFiles(db, "sample", 100, 200)[0];
    expect(merged?.source).toBe("git-merge");
    expect(merged?.complete).toBe(true);
    expect(merged?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
  it("keeps the Map coupling denominator and excludes broad PRs before pairing", () => {
    for (let n = 1; n <= 4; n++) {
      pr(n, 100 + n);
      files(n, ["src/a.ts", "src/b.ts"]);
    }
    pr(5, 110);
    files(5, ["src/a.ts"]);
    pr(6, 111);
    files(6, ["src/a.ts", "src/b.ts", ...Array.from({ length: 24 }, (_, i) => `src/wide-${i}.ts`)]);
    const result = aggregateDatedRisk(datedPrFiles(db, "sample", 100, 200));
    expect(result.touches.get("src/a.ts")?.size).toBe(6);
    expect(result.excludedBroadPrs).toBe(1);
    expect(result.coupling).toEqual([
      {
        left: "src/a.ts",
        right: "src/b.ts",
        sharedPrs: 4,
        lessFrequentlyChangedFilePrs: 4,
        sharePercent: 100,
        excludedBroadPrThreshold: 25,
      },
    ]);
  });
  it("retains the 50-percent coupling threshold and four-PR minimum", () => {
    for (let n = 1; n <= 4; n++) {
      pr(n, 100 + n);
      files(n, ["src/a.ts", "src/b.ts"]);
    }
    for (let n = 5; n <= 9; n++) {
      pr(n, 100 + n);
      files(n, ["src/a.ts"]);
      pr(n + 10, 100 + n);
      files(n + 10, ["src/b.ts"]);
    }
    const result = aggregateDatedRisk(datedPrFiles(db, "sample", 100, 200));
    expect(result.coupling).toEqual([]);
  });
  it("requires each reported head for incidence and unions a PR's captured paths", () => {
    review(1, 10);
    review(2, 10, sha(20));
    review(3, 11);
    files(10, ["src/a.ts"], "github-head");
    files(11, ["src/b.ts"], "github-head");
    expect(reviewedFileMembership(db, "sample", 100, 200).complete).toBe(false);
    store.recordCodeHealthMembership({
      repoId: "sample",
      pr: 10,
      sha: sha(20),
      kind: "github-head",
      files: ["src/b.ts"],
      declaredFiles: 1,
      at: 170,
    });
    const result = reviewedFileMembership(db, "sample", 100, 200);
    expect(result.complete).toBe(true);
    expect(result.eligiblePrs).toEqual([
      { repoId: "sample", pr: 10 },
      { repoId: "sample", pr: 11 },
    ]);
    expect([...(result.files.get(10) ?? [])].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
  it("keeps broad-file exclusion based on the full diff, including generated files", () => {
    for (let n = 1; n <= 4; n++) {
      pr(n, 100 + n);
      files(n, [
        "src/a.ts",
        "src/b.ts",
        ...Array.from({ length: 24 }, (_, i) => `generated/file-${i}.ts`),
      ]);
    }
    const result = aggregateDatedRisk(datedPrFiles(db, "sample", 100, 200));
    expect(result.touches.size).toBe(2);
    expect(result.coupling).toEqual([]);
    expect(result.excludedBroadPrs).toBe(4);
  });
  it("rejects scope escapes and names generated/vendor/binary exclusions", () => {
    for (const path of [
      "/outside/file.ts",
      "../file.ts",
      "src/../file.ts",
      "C:/file.ts",
      "src\\file.ts",
      "~/.config/file",
    ]) {
      expect(riskPath(path)).toBe(false);
      expect(() => files(1, [path])).toThrow(/Invalid/);
    }
    for (const path of [
      "vendor/a.ts",
      "dist/a.js",
      "src/generated/a.ts",
      "node_modules/a.ts",
      "pnpm-lock.yaml",
      "docs/example.png",
    ]) {
      expect(riskFile(path)).toBe(false);
    }
    expect(riskFile("src/example.ts")).toBe(true);
  });
  it("updates relevant source revisions without rewriting an identical head snapshot", () => {
    const before = store.codeHealthRevision("sample");
    files(1, ["src/a.ts"], "github-head");
    const first = store.codeHealthRevision("sample");
    expect(first).not.toBe(before);
    files(1, ["src/a.ts"], "github-head");
    expect(store.codeHealthRevision("sample")).toBe(first);
    files(1, ["src/a.ts", "src/b.ts"], "github-head");
    expect(store.codeHealthRevision("sample")).not.toBe(first);
    expect(store.codeHealthRevision("other")).toBe("");
  });
  it("recomputes dated touches and coupling independently for 7/30/90 days", () => {
    for (let n = 1; n <= 4; n++) {
      pr(n, NOW - n * DAY);
      files(n, ["src/a.ts", "src/b.ts"]);
    }
    pr(5, NOW - 10 * DAY);
    files(5, ["src/a.ts"]);
    pr(6, NOW - 45 * DAY);
    files(6, ["src/a.ts"]);
    const reader = new CodeHealthReader(store, config, () => NOW);
    for (const [window, touches] of [
      ["7d", 4],
      ["30d", 5],
      ["90d", 6],
    ] as const) {
      const view = reader.read("sample", window, "risk");
      if (view.data.tab !== "risk") throw Error("Wrong tab");
      expect(view.data.files.find((row) => row.path === "src/a.ts")).toMatchObject({
        mergedPrTouches: touches,
        lines: null,
        additions: null,
        deletions: null,
      });
      expect(view.data.coupling[0]).toMatchObject({
        sharedPrs: 4,
        lessFrequentlyChangedFilePrs: 4,
        sharePercent: 100,
      });
      const page = reader.evidence("sample", view.data.coupling[0].evidence[0].id, undefined);
      expect(page.rows.map((row) => row.pr)).toEqual([4, 3, 2, 1]);
      expect(page.rows.every((row) => row.source === "git-merge" && row.sha)).toBe(true);
      expect(
        view.coverage.find((row) => row.source === "dated merged-PR file membership")?.complete,
      ).toBe(false);
    }
    expect(reader.read("other", "90d", "risk").data).toMatchObject({ files: [], coupling: [] });
  });
  it("publishes incidence only with every reviewed head, and keeps outside-diff findings separate", () => {
    review(1, 1, sha(1), "sample", NOW - DAY);
    review(2, 2, sha(2), "sample", NOW - DAY);
    const insert = db.prepare(
      `INSERT INTO review_findings(review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,state)VALUES(?,?,?,'Minor','src/a.ts',1,'Example','Example','Example','logged')`,
    );
    insert.run(1, "run-1", 0);
    insert.run(1, "run-1", 1);
    insert.run(2, "run-2", 0);
    files(1, ["src/a.ts"], "github-head");
    const reader = new CodeHealthReader(store, config, () => NOW);
    const incomplete = reader.read("sample", "30d", "risk");
    if (incomplete.data.tab !== "risk") throw Error("Wrong tab");
    expect(incomplete.data.files[0]).toMatchObject({
      findings: 3,
      outsideDiffFindings: null,
      incidence: { percent: null },
    });
    const missingRef = incomplete.data.files[0].evidence.find((ref) =>
      ref.label.startsWith("Incidence denominator"),
    );
    if (!missingRef) throw Error("Missing incidence reference");
    const missingRows = reader.evidence("sample", missingRef.id, undefined).rows;
    expect(missingRows[1]).toMatchObject({ pr: 2, complete: false, changedFile: null });
    files(2, ["src/b.ts"], "github-head");
    const complete = reader.read("sample", "30d", "risk");
    if (complete.data.tab !== "risk") throw Error("Wrong tab");
    expect(complete.data.files[0]).toMatchObject({
      findings: 3,
      outsideDiffFindings: 1,
      incidence: { numerator: 1, denominator: 1, percent: 100 },
    });
    expect(() => reader.evidence("sample", missingRef.id, undefined)).toThrow(/source changed/);
  });
  it("pages bounded dated evidence and invalidates it after membership changes", () => {
    for (let n = 1; n <= 55; n++) {
      pr(n, NOW - DAY + n);
      files(n, ["src/a.ts"]);
    }
    const reader = new CodeHealthReader(store, config, () => NOW);
    const view = reader.read("sample", "7d", "risk");
    const ref = view.evidence.find((row) => row.label === "Dated merged PR cohort");
    if (!ref) throw Error("Missing cohort reference");
    const first = reader.evidence("sample", ref.id, undefined);
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).toBe("50");
    expect(reader.evidence("sample", ref.id, "50").rows).toHaveLength(5);
    expect(first.rows[0]).not.toHaveProperty("files");
    expect(() => reader.evidence("other", ref.id, undefined)).toThrow(/unavailable/);
    pr(56, NOW - DAY); // Missing provenance must remove exact counts, not retain a cached 55.
    const changed = reader.read("sample", "7d", "risk");
    if (changed.data.tab !== "risk") throw Error("Wrong tab");
    expect(changed.data.files[0].mergedPrTouches).toBeNull();
    expect(changed.data.coupling).toEqual([]);
    expect(() => reader.evidence("sample", ref.id, undefined)).toThrow(/source changed/);
  });
  it("reports pair-bound overflow as unavailable, with measured collection time separate from merge dates", () => {
    for (let n = 1; n <= 68; n++) {
      pr(n, NOW - n * 1000);
      files(
        n,
        Array.from({ length: 25 }, (_, index) => `src/group-${n}/file-${index}.ts`),
      );
    }
    const reader = new CodeHealthReader(store, config, () => NOW);
    const view = reader.read("sample", "7d", "risk");
    expect(view.data).toMatchObject({ coupling: [] });
    const gap = view.coverage.find((row) => row.source === "selected-window coupling");
    expect(gap).toMatchObject({ state: "not-collected", collectedAt: 200 });
    expect(gap?.note).toContain("20,000-pair");
    expect(
      view.coverage.find((row) => row.source === "dated merged-PR file membership")?.collectedAt,
    ).toBe(200);
  });
  it("bounds membership housekeeping and preserves referenced heads until their source is removed", async () => {
    // All snapshots are old. Two are still evidence; 250 have no remaining references.
    for (let n = 1; n <= 252; n++) files(n, ["src/a.ts"], "github-head");
    review(1, 1, sha(1), "sample", NOW - DAY);
    pr(2, NOW - DAY);
    const count = () =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM code_health_file_memberships").get()?.n);
    await store.pruneHistory(NOW);
    expect(count()).toBe(154); // One bounded100-row scan, including two retained heads.
    await store.pruneHistory(NOW);
    await store.pruneHistory(NOW);
    expect(count()).toBe(2);
    db.exec("DELETE FROM reviews; DELETE FROM pr_history");
    await store.pruneHistory(NOW);
    expect(count()).toBe(0);
  });
  it("keeps oversized risk tool responses useful, names omissions and preserves inspectable references", () => {
    const reader = new CodeHealthReader(store, config, () => NOW);
    const view = reader.read("sample", "7d", "risk");
    if (view.data.tab !== "risk") throw Error("Wrong tab");
    const ref = view.evidence[0];
    const file = {
      path: "src/example.ts",
      lines: null,
      analysedSha: null,
      mergedPrTouches: null,
      additions: null,
      deletions: null,
      findings: null,
      outsideDiffFindings: null,
      incidence: null,
      evidence: [ref],
    };
    view.data.files = Array.from({ length: 150 }, (_, i) => ({
      ...file,
      path: `src/file-${i}.ts`,
    }));
    const result = codeHealthToolSummary(view) as CodeHealthView & {
      summaryLimits: { omittedFiles: number };
    };
    if (result.data.tab !== "risk") throw Error("Wrong tab");
    expect(result.data.files).toHaveLength(20);
    expect(result.summaryLimits.omittedFiles).toBe(130);
    expect(reader.evidence("sample", result.data.files[0].evidence[0].id, undefined)).toMatchObject(
      { rows: [] },
    );
    expect(view.data.files).toHaveLength(150);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(115000);
    // Long evidence strings require a smaller prefix, never an over-budget response.
    view.data.files.forEach((row) => {
      row.evidence = [{ ...ref, label: "x".repeat(8000) }];
    });
    const long = codeHealthToolSummary(view) as CodeHealthView & {
      summaryLimits: { omittedFiles: number };
    };
    expect(JSON.stringify(long).length).toBeLessThanOrEqual(115000);
    expect(long.summaryLimits.omittedFiles).toBeGreaterThan(130);
  });
});
