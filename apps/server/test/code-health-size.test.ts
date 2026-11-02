import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodeHealthView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGitFileSource, gitFileHead } from "../src/code-health/git-source.ts";
import { CodeHealthReader } from "../src/code-health/read.ts";
import { collectFileSizes, type FileSizeSnapshot } from "../src/code-health/size-source.ts";
import { codeHealthToolSummary } from "../src/code-health/tool-summary.ts";
import type { CcConfig } from "../src/config.ts";
import type { GitExec } from "../src/files.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  DAY = 86400000;
const sha = (n: number) => n.toString(16).padStart(40, "0");
describe("recorded file-size observations", () => {
  let root: string, checkout: string, store: Store, db: DatabaseSync, config: CcConfig;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-code-health-size-"));
    checkout = join(root, "checkout");
    mkdirSync(checkout);
    git("init", "-q", "-b", "main");
    store = new Store(join(root, "fixture.sqlite"));
    db = new DatabaseSync(join(root, "fixture.sqlite"));
    config = {
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
        worktrees: join(root, "worktrees"),
        maxSeats: 4,
        sessions: [{ id: "sample", repoId: "sample", checkout, seats: [] }],
      },
    };
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const snapshot = (
    n: number,
    files = [{ path: "src/example.ts", lines: n }],
  ): FileSizeSnapshot => ({
    version: 1,
    analysedSha: sha(n),
    files,
    excludedBinaryFiles: 0,
    elapsedMs: 1,
  });
  const record = (n: number, at: number, files?: { path: string; lines: number }[]) =>
    store.recordCodeHealthSizeSnapshot("sample", checkout, snapshot(n, files), at);
  it("counts regular committed text with binary/vendor/generated exclusions before ranking", async () => {
    mkdirSync(join(checkout, "src"));
    mkdirSync(join(checkout, "vendor"));
    mkdirSync(join(checkout, "generated"));
    writeFileSync(join(checkout, "src/final.ts"), "first\r\nlast");
    writeFileSync(join(checkout, "src/empty.ts"), "");
    writeFileSync(join(checkout, "unknown.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(checkout, "vendor/large.ts"), "vendor\n".repeat(10000));
    writeFileSync(join(checkout, "generated/large.ts"), "generated\n".repeat(10000));
    symlinkSync("src/final.ts", join(checkout, "symbolic.ts"));
    for (let i = 0; i < 60; i++)
      writeFileSync(join(checkout, `src/file-${i}.ts`), "line\n".repeat(i + 1));
    git("add", ".");
    git("commit", "-qm", "sizes");
    const head = git("rev-parse", "HEAD"),
      index = readFileSync(join(checkout, ".git/index"));
    const measured = await collectFileSizes(checkout, head);
    expect(measured.excludedBinaryFiles).toBe(1);
    expect(measured.files).toContainEqual({ path: "src/final.ts", lines: 2 });
    expect(measured.files).toContainEqual({ path: "src/empty.ts", lines: 0 });
    expect(measured.files.some((file) => /vendor|generated|symbolic|unknown/.test(file.path))).toBe(
      false,
    );
    expect(readFileSync(join(checkout, ".git/index"))).toEqual(index);
    store.recordCodeHealthSizeSnapshot("sample", checkout, measured, NOW - 1000);
    const source = store.codeHealthSizeSnapshot("sample", checkout);
    expect(source?.files).toHaveLength(50);
    expect(source?.files[0]).toEqual({ path: "src/file-59.ts", lines: 60 });
  });
  it("keeps one SHA incomparable, then uses actual capture dates for a measured comparison", () => {
    record(1, NOW - DAY);
    store.checkCodeHealthSizes("sample", checkout, sha(1), NOW - 1);
    const reader = new CodeHealthReader(store, config, () => NOW);
    const first = reader.read("sample", "7d", "risk");
    if (first.data.tab !== "risk") throw Error("Wrong tab");
    expect(first.data.sizeHistory[0]).toMatchObject({
      path: "src/example.ts",
      comparable: false,
      points: [{ at: NOW - DAY, sha: sha(1), lines: 1 }],
    });
    expect(first.coverage.find((row) => row.source === "comparable size history")?.state).toBe(
      "not-collected",
    );
    record(2, NOW - 1000);
    const second = reader.read("sample", "7d", "risk");
    if (second.data.tab !== "risk") throw Error("Wrong tab");
    expect(second.data.sizeHistory[0]).toMatchObject({
      comparable: true,
      points: [
        { at: NOW - DAY, sha: sha(1), lines: 1 },
        { at: NOW - 1000, sha: sha(2), lines: 2 },
      ],
    });
    const historyRef = second.data.sizeHistory[0].evidence[0];
    const page = reader.evidence("sample", historyRef.id, undefined);
    expect(page.rows).toHaveLength(2);
    expect(() => reader.evidence("other", historyRef.id, undefined)).toThrow(/unavailable/);
    store.checkCodeHealthSizes("sample", checkout, sha(2), NOW + 1000);
    expect(store.codeHealthSizeSnapshot("sample", checkout)?.collectedAt).toBe(NOW - 1000);
  });
  it("bounds stored history, selects actual window points and pages intermediate evidence", () => {
    for (let n = 1; n <= 120; n++) record(n, NOW - (120 - n) * DAY - 1000);
    const count = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM code_health_size_snapshots WHERE repo_id='sample'")
        .get()?.n,
    );
    expect(count).toBeLessThanOrEqual(94);
    const month = store.codeHealthSizeHistory(
      "sample",
      checkout,
      ["src/example.ts"],
      NOW - 30 * DAY,
      NOW,
      sha(120),
    );
    expect(month[0].points).toHaveLength(2);
    expect(month[0].points[0].at).toBeGreaterThanOrEqual(NOW - 30 * DAY);
    expect(month[0].points[1].at).toBe(NOW - 1000);
    const first = store.codeHealthEvidence({
      repoId: "sample",
      kind: "size-history",
      file: "src/example.ts",
      from: NOW - 90 * DAY,
      until: NOW,
      checkout,
      offset: 0,
      limit: 50,
    });
    expect(first).toHaveLength(51);
    const rest = store.codeHealthEvidence({
      repoId: "sample",
      kind: "size-history",
      file: "src/example.ts",
      from: NOW - 90 * DAY,
      until: NOW,
      checkout,
      offset: 50,
      limit: 50,
    });
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.length).toBeLessThanOrEqual(50);
  });
  it("keeps repo/checkout/policy separate and does not invent pre-rename observations", () => {
    record(1, NOW - DAY, [{ path: "src/old.ts", lines: 10 }]);
    record(2, NOW - 1000, [{ path: "src/new.ts", lines: 11 }]);
    expect(
      store.codeHealthSizeHistory(
        "sample",
        checkout,
        ["src/new.ts"],
        NOW - 30 * DAY,
        NOW,
        sha(2),
      )[0],
    ).toMatchObject({ comparable: false, points: [{ sha: sha(2), lines: 11 }] });
    expect(store.codeHealthSizeSnapshot("other", checkout)).toBeNull();
    expect(store.codeHealthSizeSnapshot("sample", join(root, "other"))).toBeNull();
    expect(() =>
      store.recordCodeHealthSizeSnapshot("sample", checkout, { ...snapshot(3), version: 2 }, NOW),
    ).toThrow(/Invalid/);
    store.failCodeHealthSizes("sample", checkout, sha(3), NOW);
    expect(store.codeHealthSizeSnapshot("sample", checkout)?.status).toBe("unavailable");
  });
  it("fails closed on incomplete rows, unsafe data and malformed blob boundaries", async () => {
    record(1, NOW - 1000);
    db.prepare("DELETE FROM code_health_file_sizes WHERE repo_id='sample'").run();
    expect(() => store.codeHealthSizeSnapshot("sample", checkout)).toThrow(/Incomplete/);
    expect(() =>
      store.recordCodeHealthSizeSnapshot(
        "sample",
        checkout,
        snapshot(2, [{ path: "../outside.ts", lines: 2 }]),
        NOW,
      ),
    ).toThrow(/Invalid/);
    writeFileSync(join(checkout, "file.ts"), "hello\n");
    git("add", ".");
    git("commit", "-qm", "file");
    const head = git("rev-parse", "HEAD");
    await expect(
      collectFileSizes(checkout, head, { blobs: async () => Buffer.from("broken\n") }),
    ).rejects.toThrow(/identity/);
  });
  it("requires verified no-lazy-fetch support before head, log or blob object access", async () => {
    let blobCalled = false;
    const operations = [
      (exec: GitExec) =>
        collectFileSizes(checkout, sha(1), {
          exec,
          blobs: async () => {
            blobCalled = true;
            return Buffer.alloc(0);
          },
        }),
      (exec: GitExec) => collectGitFileSource(checkout, exec, NOW - 91 * DAY),
      (exec: GitExec) => gitFileHead(checkout, exec),
    ];
    for (const operation of operations) {
      let objectCommand = false;
      const exec: GitExec = async (args) => {
        if (args.includes("version")) throw Object.assign(Error("unsupported"), { code: 129 });
        objectCommand = true;
        return "";
      };
      await expect(operation(exec)).rejects.toThrow(/verified no-lazy-fetch/);
      expect(objectCommand).toBe(false);
    }
    expect(blobCalled).toBe(false);
  });
  it("distinguishes stale and failed collection from never-collected while preserving last captured provenance", () => {
    record(1, NOW - DAY);
    store.checkCodeHealthSizes("sample", checkout, sha(1), NOW - 15 * 60000);
    const reader = new CodeHealthReader(store, config, () => NOW);
    const stale = reader.read("sample", "30d", "risk");
    expect(stale.coverage.find((row) => row.source === "cached file-size snapshot")).toMatchObject({
      state: "stale",
      analysedSha: sha(1),
      collectedAt: NOW - DAY,
    });
    store.failCodeHealthSizes("sample", checkout, sha(2), NOW);
    const failed = reader.read("sample", "30d", "risk");
    const coverage = failed.coverage.find((row) => row.source === "cached file-size snapshot");
    expect(coverage).toMatchObject({ state: "error", analysedSha: sha(1), collectedAt: NOW - DAY });
    expect(coverage?.note).not.toContain("not been collected");
    expect(failed.data).toMatchObject({ files: [], sizeHistory: [] });
  });
  it("uses current-SHA capture provenance when a ref returns to an earlier cached snapshot", () => {
    record(1, NOW - DAY);
    record(2, NOW - 1000);
    record(1, NOW);
    const view = new CodeHealthReader(store, config, () => NOW + 1).read("sample", "30d", "risk");
    expect(view.coverage.find((row) => row.source === "cached file-size snapshot")).toMatchObject({
      state: "available",
      analysedSha: sha(1),
      collectedAt: NOW - DAY,
      observedFrom: NOW - DAY,
      observedUntil: NOW - DAY,
    });
  });
  it("keeps many long-path histories within the tool budget without changing full HTTP data", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/${"segment/".repeat(40)}file-${i}.ts`,
      lines: 1000 + i,
    }));
    record(1, NOW - DAY, files);
    record(
      2,
      NOW - 1000,
      files.map((file) => ({ ...file, lines: file.lines + 1 })),
    );
    const reader = new CodeHealthReader(store, config, () => NOW),
      view = reader.read("sample", "30d", "risk");
    if (view.data.tab !== "risk") throw Error("Wrong tab");
    const summary = codeHealthToolSummary(view) as CodeHealthView & {
      summaryLimits: { omittedHistories: number };
    };
    if (summary.data.tab !== "risk") throw Error("Wrong tab");
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(115000);
    expect(summary.summaryLimits.omittedHistories + summary.data.sizeHistory.length).toBe(
      view.data.sizeHistory.length,
    );
    expect(view.data.sizeHistory).toHaveLength(50);
    const ref = summary.data.sizeHistory[0]?.evidence[0];
    if (!ref) throw Error("Missing history evidence");
    expect(reader.evidence("sample", ref.id, undefined).rows).toHaveLength(2);
  });
});
