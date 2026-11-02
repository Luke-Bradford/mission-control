import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import { createGitFileCollector } from "../src/code-health/git-collector.ts";
import { collectGitFileSource, parseGitFileLog } from "../src/code-health/git-source.ts";
import { CodeHealthReader } from "../src/code-health/read.ts";
import type { CcConfig } from "../src/config.ts";
import { realGitExec } from "../src/files.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  DAY = 86400000;
describe("read-only git file evidence", () => {
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
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-code-health-git-"));
    checkout = join(root, "checkout");
    mkdirSync(checkout);
    git("init", "-q", "-b", "main");
    writeFileSync(
      join(checkout, "old.ts"),
      Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i};\n`).join(""),
    );
    commit("initial");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
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
  function history(pr: number, sha: string, mergedAt = NOW - DAY, repo = "sample") {
    db.prepare("INSERT INTO pr_history(repo_id,number,merged_at,record)VALUES(?,?,?,?)").run(
      repo,
      pr,
      mergedAt,
      JSON.stringify({ mergeCommitSha: sha }),
    );
  }
  function mergedChange() {
    git("checkout", "-qb", "feature");
    renameSync(join(checkout, "old.ts"), join(checkout, "new.ts"));
    writeFileSync(
      join(checkout, "new.ts"),
      readFileSync(join(checkout, "new.ts"), "utf8") + "export const extra = true;\n",
    );
    writeFileSync(join(checkout, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    mkdirSync(join(checkout, "vendor"));
    writeFileSync(join(checkout, "vendor/dependency.ts"), "vendor\n");
    commit("rename and change");
    git("checkout", "main");
    git("merge", "--no-ff", "-qm", "merge feature", "feature");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    return git("rev-parse", "HEAD");
  }
  it("reads actual rename and binary numstats without changing the checkout or running configured programs", async () => {
    const sha = mergedChange(),
      marker = join(root, "unexpected-program");
    git("config", "diff.external", `touch ${marker}`);
    git("config", "log.showSignature", "true");
    git("config", "gpg.program", `touch ${marker}`);
    const before = readFileSync(join(checkout, ".git/index"));
    const source = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    expect(source.analysedSha).toBe(sha);
    expect(source.commits[0].changes).toContainEqual({
      path: "new.ts",
      previousPath: "old.ts",
      additions: 1,
      deletions: 0,
    });
    expect(source.commits[0].changes).toContainEqual({
      path: "binary.bin",
      previousPath: null,
      additions: null,
      deletions: null,
    });
    expect(readFileSync(join(checkout, ".git/index"))).toEqual(before);
    expect(git("status", "--porcelain")).toBe("");
    expect(() => readFileSync(marker)).toThrow();
  });
  it("uses merge dates for exact windows, captures merge membership and preserves missing/binary counts", async () => {
    const sha = mergedChange();
    history(1, sha, NOW - 10 * DAY);
    const source = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    store.recordCodeHealthGitSource("sample", checkout, source, NOW);
    const reader = new CodeHealthReader(store, config, () => NOW);
    const month = reader.read("sample", "30d", "risk");
    if (month.data.tab !== "risk") throw Error("Wrong tab");
    expect(month.data.files.find((row) => row.path === "new.ts")).toMatchObject({
      additions: 1,
      deletions: 0,
      mergedPrTouches: 1,
    });
    expect(month.data.files.find((row) => row.path === "old.ts")).toMatchObject({
      additions: 0,
      deletions: 0,
    });
    expect(month.data.files.find((row) => row.path === "binary.bin")).toMatchObject({
      additions: null,
      deletions: null,
    });
    expect(month.data.files.some((row) => row.path.startsWith("vendor/"))).toBe(false);
    const week = reader.read("sample", "7d", "risk");
    if (week.data.tab !== "risk") throw Error("Wrong tab");
    expect(week.data.files).toEqual([]);
    expect(store.codeHealthDatedRisk("sample", NOW - 30 * DAY, NOW).complete).toBe(true);
    const ref = month.data.files
      .find((row) => row.path === "new.ts")
      ?.evidence.find((ref) => ref.label.startsWith("Git numstats:"));
    if (!ref) throw Error("Missing evidence");
    expect(reader.evidence("sample", ref.id, undefined).rows[0]).toMatchObject({
      pr: 1,
      sha,
      path: "new.ts",
      previousPath: "old.ts",
      additions: 1,
    });
    history(2, "f".repeat(40));
    const unknown = reader.read("sample", "30d", "risk");
    if (unknown.data.tab !== "risk") throw Error("Wrong tab");
    expect(
      unknown.data.files.every((row) => row.additions === null && row.deletions === null),
    ).toBe(true);
  });
  it("caches by immutable default head and checkout, and links PRs that arrive after collection", async () => {
    const sha = mergedChange(),
      calls: string[][] = [];
    let at = NOW;
    const collector = createGitFileCollector({
      config,
      store,
      bus: new ChangeBus(),
      now: () => at,
      exec: async (args) => {
        calls.push(args);
        return realGitExec(args);
      },
    });
    await collector.tick();
    expect(calls.filter((args) => args.includes("log"))).toHaveLength(1);
    history(1, sha);
    at += 1000;
    await collector.tick();
    expect(calls.filter((args) => args.includes("log"))).toHaveLength(1);
    expect(store.codeHealthDatedRisk("sample", NOW - 30 * DAY, NOW).complete).toBe(true);
    expect(store.codeHealthGitSource("other", checkout)).toBeNull();
    expect(store.codeHealthGitSource("sample", join(root, "other"))).toBeNull();
    expect(
      calls.every((args) => args.includes("--no-optional-locks") || args.includes("version")),
    ).toBe(true);
    await collector.stop();
    await collector.tick();
    expect(calls.filter((args) => args.includes("log"))).toHaveLength(1);
  });
  it("fails closed after collection errors and stale checks", async () => {
    const sha = mergedChange();
    history(1, sha);
    const source = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    store.recordCodeHealthGitSource("sample", checkout, source, NOW);
    expect(
      store.codeHealthGitMetrics("sample", checkout, NOW - 30 * DAY, NOW, NOW + 15 * 60000)
        .complete,
    ).toBe(false);
    const collector = createGitFileCollector({
      config,
      store,
      bus: new ChangeBus(),
      now: () => NOW + 1000,
      exec: async () => {
        throw Error("fixture failure");
      },
    });
    await collector.tick();
    expect(store.codeHealthGitSource("sample", checkout)?.status).toBe("unavailable");
    expect(
      store.codeHealthGitMetrics("sample", checkout, NOW - 30 * DAY, NOW, NOW + 1000).complete,
    ).toBe(false);
    await collector.stop();
  });
  it("rejects malformed rename records, duplicate commit identities and unsafe paths", () => {
    const header = [
      "",
      "MC_CODE_HEALTH_COMMIT",
      "a".repeat(40),
      "1793000000",
      `${"b".repeat(40)} ${"c".repeat(40)}`,
      "",
      "\n",
    ].join("\0");
    expect(
      parseGitFileLog(
        header +
          `:100644 100644 ${"b".repeat(40)} ${"c".repeat(40)} R99\0old.ts\0new.ts\0` +
          "1\t0\t\0old.ts\0new.ts\0",
      )[0].changes[0],
    ).toMatchObject({
      previousPath: "old.ts",
      path: "new.ts",
    });
    for (const output of [
      header + "1\t0\t\0old.ts\0",
      header + "1\t0\t../outside.ts\0",
      header + header,
      header + "-\t1\ta.ts\0",
    ])
      expect(() => parseGitFileLog(output)).toThrow();
  });
  it("keeps raw gitlinks in broad-PR width while excluding them from file touches", async () => {
    mkdirSync(join(checkout, "src"));
    for (let n = 1; n <= 4; n++) {
      const previous = git("rev-parse", "HEAD");
      git("checkout", "-qb", `wide-${n}`);
      for (let i = 0; i < 24; i++)
        writeFileSync(join(checkout, `src/file-${i}.ts`), `export const value = ${n};\n`);
      git("add", ".");
      for (const name of ["modules/first", "modules/second"])
        git("update-index", "--add", "--cacheinfo", `160000,${previous},${name}`);
      git("commit", "-qm", `wide ${n}`);
      git("checkout", "main");
      git("merge", "--no-ff", "-qm", `merge ${n}`, `wide-${n}`);
      history(n, git("rev-parse", "HEAD"), NOW - n * 1000);
    }
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const source = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    expect(source.commits[0].rawPaths).toHaveLength(26);
    expect(source.commits[0].excludedPaths).toHaveLength(2);
    store.recordCodeHealthGitSource("sample", checkout, source, NOW);
    const dated = store.codeHealthDatedRisk("sample", NOW - 7 * DAY, NOW);
    expect(dated.complete).toBe(true);
    expect(dated.excludedBroadPrs).toBe(4);
    expect(dated.coupling).toEqual([]);
    expect(dated.touches.size).toBe(24);
    expect(dated.touches.has("modules/first")).toBe(false);
  });
  it("pins tree attributes, rejects local override rules, and rechecks them on cached heads", async () => {
    mergedChange();
    const first = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    writeFileSync(join(checkout, ".gitattributes"), "binary.bin diff\n");
    const dirty = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    expect(dirty.commits).toEqual(first.commits);
    const collector = createGitFileCollector({
      config,
      store,
      bus: new ChangeBus(),
      now: () => NOW,
    });
    await collector.tick();
    writeFileSync(join(checkout, ".git/info/attributes"), "binary.bin diff\n");
    await expect(collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY)).rejects.toThrow(
      /Local attribute rules/,
    );
    await collector.tick();
    expect(store.codeHealthGitSource("sample", checkout)?.status).toBe("unavailable");
    await collector.stop();
  });
  it("keeps a single-parent merge point unknown instead of using a possible final rebase commit", async () => {
    writeFileSync(join(checkout, "old.ts"), "export const changed = true;\n");
    const sha = commit("single parent");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    history(1, sha);
    const source = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    store.recordCodeHealthGitSource("sample", checkout, source, NOW);
    expect(store.codeHealthGitMetrics("sample", checkout, NOW - 7 * DAY, NOW, NOW).complete).toBe(
      false,
    );
    expect(store.codeHealthDatedRisk("sample", NOW - 7 * DAY, NOW).complete).toBe(false);
  });
  it("rejects damaged snapshots with omitted line evidence instead of inventing zero churn", async () => {
    const sha = mergedChange();
    history(1, sha);
    const source = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    store.recordCodeHealthGitSource("sample", checkout, source, NOW);
    const damaged = structuredClone(source.commits);
    damaged[0].changes = [];
    db.prepare("UPDATE code_health_git_sources SET payload=? WHERE repo_id='sample'").run(
      JSON.stringify(damaged),
    );
    expect(() => store.codeHealthGitMetrics("sample", checkout, NOW - 7 * DAY, NOW, NOW)).toThrow(
      /numstat coverage/,
    );
  });
  it("ignores replacement objects and rejects legacy parent grafts at the same analysed SHA", async () => {
    const sha = mergedChange(),
      p1 = git("rev-parse", "HEAD^1"),
      p2 = git("rev-parse", "HEAD^2");
    const before = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    writeFileSync(join(checkout, "replacement.ts"), "replacement\n".repeat(9));
    git("add", "replacement.ts");
    const tree = git("write-tree"),
      replacement = git("commit-tree", tree, "-p", p1, "-p", p2, "-m", "replacement");
    git("replace", sha, replacement);
    const after = await collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY);
    expect(after.analysedSha).toBe(before.analysedSha);
    expect(after.commits).toEqual(before.commits);
    writeFileSync(join(checkout, ".git/info/grafts"), `${sha} ${p2} ${p1}\n`);
    await expect(collectGitFileSource(checkout, realGitExec, NOW - 91 * DAY)).rejects.toThrow(
      /Local graft rules/,
    );
  });
});
