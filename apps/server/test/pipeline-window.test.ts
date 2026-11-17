import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciFailureClass,
  formatPipelineReport,
  pipelineWindow,
} from "../scripts/pipeline-window.ts";
import { Store } from "../src/store.ts";

const FROM = Date.parse("2026-11-16T00:00:00Z");
const UNTIL = FROM + 24 * 3_600_000;
const REPO = "mission-control";

let dir: string;
let path: string;
let raw: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipeline-window-"));
  path = join(dir, "hub.db");
  new Store(path).close();
  raw = new DatabaseSync(path);
});
afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

function crewRun(pr: number): void {
  raw
    .prepare(
      `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, transcript_path, loop)
       VALUES (?, 'guido-1', ?, 1, ?, 'ended', '', ?)`,
    )
    .run(`run-${pr}`, REPO, FROM, JSON.stringify({ prNumber: pr }));
}
function ci(
  pr: number,
  name: string,
  conclusion: string,
  firstSeen = FROM + 1000,
  attempt = 1,
  at = firstSeen,
): void {
  raw
    .prepare(
      `INSERT INTO ci_runs (repo_id, run_key, sha, name, attempt, pr_number, state, conclusion, url, first_seen_at, at)
       VALUES (?, ?, 'abcdef1234567', ?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
    )
    .run(
      REPO,
      `${pr}:${name}:${attempt}:${firstSeen}`,
      name,
      attempt,
      pr,
      conclusion,
      `https://ci/${name}`,
      firstSeen,
      at,
    );
}
function review(summary: string, endedAt = FROM + 5000): number {
  const r = raw
    .prepare(
      `INSERT INTO reviews (author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state, summary, created_at, ended_at)
       VALUES ('run-10', ?, 'retro-1', 10, 'abcdef1234567', 1, 1, 1, 'reported', ?, ?, ?)`,
    )
    .run(REPO, summary, FROM, endedAt);
  return Number(r.lastInsertRowid);
}
function finding(reviewId: number, pos: number, severity: string, summary: string): void {
  raw
    .prepare(
      `INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line, summary, scenario, fix, state)
       VALUES (?, 'run-10', ?, ?, 'a.ts', 1, ?, 'scenario', 'fix', 'open')`,
    )
    .run(reviewId, pos, severity, summary);
}
const input = { repoId: REPO, from: FROM, until: UNTIL };

describe("pipelineWindow", () => {
  it("counts crew-PR CI failures by class and leaves out other PRs, the summary job and rows outside the window", () => {
    crewRun(10);
    ci(10, "validate", "FAILURE");
    ci(10, "server (1)", "TIMED_OUT");
    ci(10, "web-core", "SUCCESS");
    ci(10, "check", "FAILURE");
    ci(10, "server (2)", "FAILURE", FROM - 1);
    ci(11, "validate", "FAILURE");
    const r = pipelineWindow(raw, input);
    expect(r.crewPrs).toBe(1);
    expect(r.ciResults).toBe(3);
    expect(r.failures).toHaveLength(2);
    expect(r.byClass).toEqual({ "lint-typecheck-build": 1, tests: 1, other: 0 });
    const lines = formatPipelineReport(r);
    expect(lines.slice(0, 5)).toEqual([
      "Pipeline window 2026-11-16T00:00:00.000Z to 2026-11-17T00:00:00.000Z, repo mission-control",
      "Crew PRs with CI results: 1; job results: 3; failed: 2",
      "Failed, lint/typecheck/build (validate): 1",
      "Failed, tests (server, server-process, web-core): 1",
      "Failed, other: 0",
    ]);
    expect(lines.slice(5, 7)).toEqual([
      "  PR 10 abcdef1 server (1) https://ci/server (1)",
      "  PR 10 abcdef1 validate https://ci/validate",
    ]);
  });

  it("places a CI job by when it was first seen, not by its last poll", () => {
    crewRun(10);
    // first seen inside the window, polled again after it ends: still counted
    ci(10, "validate", "FAILURE", FROM + 1000, 1, UNTIL + 5000);
    // first seen before the window, polled inside it: not counted
    ci(10, "server (1)", "FAILURE", FROM - 5000, 1, FROM + 1000);
    // first seen exactly at the end: outside
    ci(10, "web-core", "FAILURE", UNTIL, 1, UNTIL);
    const r = pipelineWindow(raw, input);
    expect(r.ciResults).toBe(1);
    expect(r.byClass).toEqual({ "lint-typecheck-build": 1, tests: 0, other: 0 });
  });

  it("lists blocking findings that ask for controller-only evidence and counts Controller check summaries", () => {
    const id = review("Controller check: 20 CI runs");
    finding(id, 0, "Important", "Attach a screenshot of the running hub");
    finding(id, 1, "Critical", "null deref in parse");
    finding(id, 2, "Minor", "live hub link");
    const r = pipelineWindow(raw, input);
    expect(r.reviewsEnded).toBe(1);
    expect(r.blockingFindings).toBe(2);
    expect(r.controllerCheckSummaries).toBe(1);
    expect(r.controllerOnly).toHaveLength(1);
    expect(r.controllerOnly[0]?.matched).toBe("screenshot of the running hub");
  });

  it("is all zero for an empty window", () => {
    const r = pipelineWindow(raw, input);
    expect(r.failures).toEqual([]);
    expect(formatPipelineReport(r)).toContain("Failed, other: 0");
  });
});

describe("ciFailureClass", () => {
  it("maps job names", () => {
    expect(ciFailureClass("check")).toBeNull();
    expect(ciFailureClass("validate")).toBe("lint-typecheck-build");
    expect(ciFailureClass("server-process (2)")).toBe("tests");
    expect(ciFailureClass("docs")).toBe("other");
  });
});

const SCRIPT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../scripts/pipeline-window.ts",
);
const USAGE =
  "Usage: pipeline-window.ts --db <copy of the hub DB> --repo <repo id> --from <ISO time> [--hours 24]";
function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
  });
}

describe("command line", () => {
  it("reads a database copy over the default 24-hour window", () => {
    crewRun(10);
    ci(10, "validate", "FAILURE");
    const r = cli("--db", path, "--repo", REPO, "--from", "2026-11-16T00:00:00Z");
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "Pipeline window 2026-11-16T00:00:00.000Z to 2026-11-17T00:00:00.000Z, repo mission-control",
    );
    expect(lines[2]).toBe("Failed, lint/typecheck/build (validate): 1");
  });

  it("honours --hours", () => {
    const r = cli("--db", path, "--repo", REPO, "--from", "2026-11-16T00:00:00Z", "--hours", "1");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("to 2026-11-16T01:00:00.000Z");
  });

  it.each([
    ["no arguments", []],
    ["a missing --db", ["--repo", REPO, "--from", "2026-11-16T00:00:00Z"]],
    ["a missing --repo", ["--db", "x", "--from", "2026-11-16T00:00:00Z"]],
    ["a missing --from", ["--db", "x", "--repo", REPO]],
    ["an unparseable --from", ["--db", "x", "--repo", REPO, "--from", "not a date"]],
    ["zero hours", ["--db", "x", "--repo", REPO, "--from", "2026-11-16T00:00:00Z", "--hours", "0"]],
    ["non-numeric hours", ["--db", "x", "--repo", REPO, "--from", "2026-11-16T00:00:00Z", "--hours", "abc"]],
  ])("prints the usage line and exits 2 for %s", (_name, args) => {
    const r = cli(...args);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(USAGE);
    expect(r.stdout).toBe("");
  });

  it("says it did not read a missing or non-database file and exits 1", () => {
    const missing = join(dir, "nope.db");
    const a = cli("--db", missing, "--repo", REPO, "--from", "2026-11-16T00:00:00Z");
    expect(a.status).toBe(1);
    expect(a.stdout.trim()).toBe(`Not read: ${missing} is not a hub database.`);
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is not sqlite");
    const b = cli("--db", junk, "--repo", REPO, "--from", "2026-11-16T00:00:00Z");
    expect(b.status).toBe(1);
    expect(b.stdout.trim()).toBe(`Not read: ${junk} is not a hub database.`);
  });
});
