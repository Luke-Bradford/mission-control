import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { FLIGHT_GH_READ_MAX, GH_READ_CUT, GH_READ_UNTRUSTED } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import type { GhRunner } from "../src/mcp/gh.ts";
import {
  GH_READ_JOB_LOG_MAX_BUFFER,
  GH_READ_MAX_BUFFER,
  githubReadPath,
  isolatedGithubRead,
} from "../src/mcp/gh-read.ts";

describe("GitHub read paths", () => {
  it.each([
    "commits?since=2026-10-24T12:34:56Z&until=2026-10-25T13:00:00.123Z",
    "pulls",
    "pulls?head=x:other",
    "pulls?head=my-org:feature/topic-1.2_fix",
    "pulls/12",
    "pulls/12/files",
    "pulls/12/commits",
    "pulls/12/reviews",
    "pulls/12/reviews/34",
    "pulls/12/reviews/34/comments",
    "pulls/12/comments",
    "pulls/comments",
    "pulls/comments/34",
    "issues",
    "issues/12",
    "issues/12/comments",
    "issues/comments",
    "issues/comments/34",
    "commits",
    "commits/main",
    "commits/abc123/comments",
    "compare/main...feature/topic",
    "actions/runs",
    "actions/runs/12",
    "actions/runs/12/jobs",
    "actions/runs/12/attempts/2",
    "actions/runs/12/attempts/2/jobs",
    "actions/jobs/34",
    "actions/jobs/34/logs",
    "actions/runs?branch=main&status=failure&page=2&per_page=100",
  ])("allows the fixed template %s for the session repo", (resource) => {
    const path = `repos/o/mc/${resource}`;
    expect(githubReadPath(path, "o/mc")).toBe(path);
    expect(githubReadPath(`/${path}`, "o/mc")).toBe(path);
  });

  it("refuses a malformed configured repo", () => {
    expect(githubReadPath("repos/o/mc/../other/pulls", "o/mc/../other")).toBeNull();
    expect(githubReadPath("repos/../mc/pulls", "../mc")).toBeNull();
  });

  it("allows the account's rate limit", () => {
    expect(githubReadPath("rate_limit", "o/mc")).toBe("rate_limit");
  });

  it.each([
    "https://api.github.com/repos/o/mc/pulls",
    "//evil.test/repos/o/mc/pulls",
    "repos/o/mc-other/pulls",
    "repos/other/mc/pulls",
    "repos/o/mc/actions/runs/12/rerun",
    "repos/o/mc/actions/jobs/34/logs/extra",
    "repos/o/mc/commits/main/status",
    "repos/o/mc/commits/.",
    "repos/o/mc/commits/..",
    "repos/o/mc/commits/a/../b",
    "repos/o/mc/commits/%2E%2e",
    "repos/o/mc/commits/%252e%252e",
    "repos/o/mc/commits/a%2fb",
    "repos/o/mc/compare/../main...head",
    "repos/o/mc/compare/main...../head",
    "repos/o/mc/pulls?method=POST",
    "repos/o/mc/pulls?_method=DELETE",
    "repos/o/mc/pulls?%6dethod=POST",
    "repos/o/mc/pulls?--input=file",
    "repos/o/mc/pulls?page=1&page=2",
    "repos/o/mc/pulls?per_page=101",
    "repos/o/mc/pulls?",
    "repos/o/mc/pulls?branch=main?method=POST",
    "repos/o/mc/pulls#fragment",
    "repos/o/mc/pulls\n",
    "repos/o/mc/commits/{branch}",
    "repos/o/mc/pulls?head=x:owner",
    "repos/o/mc/pulls?head=x:REPO",
    "repos/o/mc/pulls?head=x:branch",
    "repos/o/mc/pulls?head=main",
    "repos/o/mc/pulls?head=:main",
    "repos/o/mc/pulls?head=my_org:main",
    "repos/o/mc/pulls?head=my.org:main",
    "repos/o/mc/pulls?head=x:",
    "repos/o/mc/pulls?head=x:/main",
    "repos/o/mc/pulls?head=x:feature//topic",
    "repos/o/mc/pulls?head=x:main:other",
    "repos/o/mc/pulls?head=x:main+other",
    "repos/o/mc/commits?since=yesterday",
    "repos/o/mc/commits?until=2026-02-30T12:00:00Z",
    "repos/o/mc/commits?since=2026-10-24T24:00:00Z",
    "repos/o/mc/commits?until=2026-10-24T12:00:00",
    "repos/o/mc/commits?since=2026-10-24T12:00:00+00:00",
    "repos/o/mc/commits?since=2026-10-24T12:00:00-01:00",
    "repos/o/mc/commits?until=2026-10-24T12:00:00.123+01:00",
    "repos/o/mc/commits?until=2026-10-24T12:00:00-00:00",
    "graphql",
    "-f",
    "-F",
    "--input",
  ])("refuses %s", (path) => {
    expect(githubReadPath(path, "o/mc")).toBeNull();
  });
});

describe("isolated GitHub read", () => {
  it.each([false, true])("keeps the token off disk and cleans up (failure: %s)", async (fail) => {
    const token = "hub-token-never-on-disk";
    const log = vi.fn();
    let root = "";
    const runner = vi.fn<GhRunner>(async (args, opts) => {
      expect(args.join(" ")).not.toContain(token);
      expect(opts.input).toBeUndefined();
      if (args[0] === "auth") {
        root = opts.cwd;
        expect(opts.env).toBeUndefined();
        expect(readdirSync(root)).toEqual([]);
        return { code: 0, stdout: `${token}\n`, stderr: "" };
      }
      expect(args).toEqual(["api", "--hostname", "github.com", "--method", "GET", "rate_limit"]);
      expect(dirname(opts.cwd)).toBe(root);
      expect(opts.env).toEqual({
        HOME: root,
        GH_CONFIG_DIR: `${root}/config`,
        GH_TOKEN: token,
        GH_HOST: "github.com",
        GH_REPO: "o/mc",
        GH_TELEMETRY: "0",
      });
      expect(opts.maxBuffer).toBe(GH_READ_MAX_BUFFER);
      expect(readdirSync(opts.cwd)).toEqual([]);
      expect(readdirSync(`${root}/config`)).toEqual([]);
      expect(readdirSync(root, { recursive: true }).sort()).toEqual(["config", "work"]);
      if (fail) throw new Error(token);
      return { code: 0, stdout: `evidence: ${token}`, stderr: token };
    });
    expect(await isolatedGithubRead(runner, "rate_limit", [], "o/mc", log)).toEqual(
      fail ? { ok: false, notFound: false } : { ok: true, text: "evidence: [redacted]" },
    );
    expect(log.mock.calls).toEqual(fail ? [["mc gh_read: gh api failed (null)"]] : []);
    expect(existsSync(root)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("withholds failed API output and stderr", async () => {
    const runner = vi.fn<GhRunner>(async (args) =>
      args[0] === "auth"
        ? { code: 0, stdout: "token", stderr: "" }
        : { code: 1, stdout: "private", stderr: "private" },
    );
    expect(await isolatedGithubRead(runner, "rate_limit", [], "o/mc")).toEqual({
      ok: false,
      notFound: false,
    });
  });

  it.each([
    ["repos/o/mc/actions/jobs/1/logs", true],
    ["/repos/o/mc/actions/jobs/1/logs?per_page=100", true],
    ["repos/o/mc/actions/jobs/1", false],
    ["repos/o/mc/actions/runs/1/jobs", false],
    ["repos/o/mc/pulls", false],
    ["rate_limit", false],
  ])("reserves the 16 MiB buffer for job logs: %s", async (path, isJobLog) => {
    const stdout = `${"setup line\n".repeat(500_000)}final failure`;
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(4 * 1024 * 1024);
    expect(GH_READ_JOB_LOG_MAX_BUFFER).toBe(16 * 1024 * 1024);
    const runner: GhRunner = async (args, opts) => {
      if (args[0] === "auth") return { code: 0, stdout: "token", stderr: "" };
      expect(opts.maxBuffer).toBe(isJobLog ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
      return {
        code: Buffer.byteLength(stdout) > (opts.maxBuffer ?? 0) ? null : 0,
        stdout,
        stderr: "",
      };
    };
    const result = await isolatedGithubRead(runner, path, [], "o/mc");
    if (isJobLog) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text.endsWith("final failure")).toBe(true);
      expect(result.text.length + GH_READ_UNTRUSTED.length).toBeLessThanOrEqual(FLIGHT_GH_READ_MAX);
    } else {
      expect(result).toEqual({ ok: false, notFound: false });
    }
  });

  it("redacts multiline credentials and secrets hidden behind diff headers", async () => {
    const secret = "known-multiline\ncredential";
    const runner = vi.fn<GhRunner>(async (args) => ({
      code: 0,
      stdout:
        args[0] === "auth"
          ? "token"
          : `before\n${secret}\ndiff --git a/x b/x\n-----BEGIN PRIVATE KEY-----\nkey material\n-----END PRIVATE KEY-----\nafter`,
      stderr: "",
    }));
    expect(await isolatedGithubRead(runner, "rate_limit", [secret], "o/mc")).toEqual({
      ok: true,
      text: "before\n[redacted]\ndiff --git a/x b/x\n[redacted]\nafter",
    });
  });
});

describe("bounded GitHub output", () => {
  const read = (stdout: string, known: string[] = [], path = "repos/o/mc/pulls") =>
    isolatedGithubRead(
      async (args) => ({ code: 0, stdout: args[0] === "auth" ? "hub-token" : stdout, stderr: "" }),
      path,
      known,
      "o/mc",
    );

  it("cleans controls before removing short known secrets", async () => {
    expect(await read("a sh\x00ort sh\x1b[31mort hub-\x00token z", ["short"])).toEqual({
      ok: true,
      text: "a [redacted] [redacted] [redacted] z",
    });
  });

  it("bounds multi-megabyte output and redacts a known secret crossing the cut", async () => {
    const secret = "sensitive".repeat(5000);
    const result = await read(`start ${secret} ${"🚀".repeat(900_000)} end`, [secret]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith("start [redacted] ")).toBe(true);
    expect(result.text.endsWith(GH_READ_CUT)).toBe(true);
    expect(result.text.length + GH_READ_UNTRUSTED.length).toBeLessThanOrEqual(FLIGHT_GH_READ_MAX);
    expect(result.text).not.toContain("sensitive");
    expect(result.text).not.toContain("end");
    expect(GH_READ_MAX_BUFFER).toBe(4 * 1024 * 1024);
  });

  it("keeps the end of large job logs, including the final failure", async () => {
    const result = await read(
      `start\n${"setup line\n".repeat(100_000)}final failure`,
      [],
      "repos/o/mc/actions/jobs/34/logs?per_page=100",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith(`${GH_READ_CUT}\n`)).toBe(true);
    expect(result.text.endsWith("final failure")).toBe(true);
    expect(result.text).not.toContain("start");
    expect(result.text.length + GH_READ_UNTRUSTED.length).toBeLessThanOrEqual(FLIGHT_GH_READ_MAX);
  });

  it("drops a credential suffix when a job-log tail has no newline", async () => {
    const result = await read(
      `${"z".repeat(5000)}ghp_${"A".repeat(36)}${"q".repeat(19870)}`,
      [],
      "repos/o/mc/actions/jobs/1/logs",
    );
    expect(result).toEqual({ ok: true, text: `${GH_READ_CUT}\n` });
  });

  it.each(["auth", "api"])("logs only the failure step and exit code for %s", async (step) => {
    const log = vi.fn();
    const runner: GhRunner = async (args) =>
      args[0] === step
        ? { code: 7, stdout: "private token", stderr: "private token" }
        : { code: 0, stdout: "private token", stderr: "" };
    expect(await isolatedGithubRead(runner, "rate_limit", [], "o/mc", log)).toEqual({
      ok: false,
      notFound: false,
    });
    expect(log.mock.calls).toEqual([
      [`mc gh_read: gh ${step === "auth" ? "auth token" : "api"} failed (7)`],
    ]);
  });

  it("reports a 404 JSON body without exposing its contents", async () => {
    const log = vi.fn();
    const runner: GhRunner = async (args) =>
      args[0] === "auth"
        ? { code: 0, stdout: "private token", stderr: "" }
        : {
            code: 1,
            stdout: JSON.stringify({ status: "404", message: "private token" }),
            stderr: "private token",
          };
    expect(await isolatedGithubRead(runner, "rate_limit", [], "o/mc", log)).toEqual({
      ok: false,
      notFound: true,
    });
    expect(log.mock.calls).toEqual([["mc gh_read: gh api failed (1)"]]);
  });
});
