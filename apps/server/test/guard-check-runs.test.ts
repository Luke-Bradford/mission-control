import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CloneState,
  checksRun,
  cloneState,
  createCheckRecorder,
} from "../src/guard/check-runs.ts";

const LINT = "pnpm -s lint";
const TYPES = "pnpm -s typecheck";
const CHECKS = [LINT, TYPES];

describe("checksRun", () => {
  it("matches a check that is one && segment exactly, after trimming", () => {
    expect(checksRun(LINT, CHECKS)).toEqual([LINT]);
    expect(checksRun(`  ${LINT}  `, CHECKS)).toEqual([LINT]);
    expect(checksRun(`${LINT} && ${TYPES}`, CHECKS)).toEqual([LINT, TYPES]);
  });

  it.each([
    ["an exit before it", `exit 0 && ${LINT}`],
    ["a shell function shadowing the runner", `pnpm() ( true ) && ${LINT}`],
    ["a cd before it", `cd fake && ${LINT}`],
    ["an edit before it", `sed -i x a.ts && ${LINT}`],
    ["an edit after it", `${LINT} && sed -i x a.ts`],
  ])("matches nothing when %s shares the chain", (_n, command) => {
    expect(checksRun(command, CHECKS)).toEqual([]);
  });

  it("matches nothing for a command that only contains a check", () => {
    expect(checksRun("pnpm -s lint --fix", CHECKS)).toEqual([]);
    expect(checksRun("echo pnpm -s lint", CHECKS)).toEqual([]);
    expect(checksRun("pnpm -s lint &", CHECKS)).toEqual([]);
    expect(checksRun("pnpm lint", CHECKS)).toEqual([]);
  });

  it.each([
    ["a pipe", `${LINT} | tail`],
    ["an or", `${LINT} || true`],
    ["a semicolon", `${LINT}; true`],
    ["a newline", `${LINT}\ntrue`],
    ["a carriage return", `${LINT}\r\ntrue`],
    ["a pipe after &&", `true && ${LINT} | cat`],
  ])("matches nothing for %s", (_n, command) => {
    expect(checksRun(command, CHECKS)).toEqual([]);
  });

  it("matches nothing when the repo configures no checks", () => {
    expect(checksRun(LINT, [])).toEqual([]);
  });
});

describe("the check recorder", () => {
  const HEAD = "a".repeat(40);
  const KEY = { runId: "r1", toolUseId: "t1" };
  let rows: { runId: string; command: string; headSha: string; ok: boolean; at: number }[];
  let state: CloneState | null;
  let checks: readonly string[];
  const recorder = () =>
    createCheckRecorder({
      store: { addCheckRun: (c) => void rows.push(c) },
      checks: async () => checks,
      state: async () => state,
      now: () => 99,
    });

  beforeEach(() => {
    rows = [];
    state = { head: HEAD, clean: true };
    checks = CHECKS;
  });

  it("records one row per matched check with the call's exit success, on the head it started on", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    await r.end(KEY, true);
    expect(rows).toEqual([
      { runId: "r1", command: LINT, headSha: HEAD, ok: true, at: 99 },
      { runId: "r1", command: TYPES, headSha: HEAD, ok: true, at: 99 },
    ]);
  });

  it("records a failed call as ok = false", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    await r.end(KEY, false);
    expect(rows.map((x) => x.ok)).toEqual([false]);
  });

  it.each([
    "pnpm -s lint | tail",
    "pnpm -s lint || true",
    "pnpm -s lint; true",
    "pnpm -s lint\ntrue",
  ])("records nothing for %j", async (command) => {
    const r = recorder();
    await r.begin(KEY, command);
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records nothing for a call that matches no check", async () => {
    const r = recorder();
    await r.begin(KEY, "ls");
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records nothing when the tree was dirty at the start", async () => {
    state = { head: HEAD, clean: false };
    const r = recorder();
    await r.begin(KEY, LINT);
    state = { head: HEAD, clean: true };
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records nothing when the call left the tree dirty (an edit during the call)", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    state = { head: HEAD, clean: false };
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records nothing when the head moved during the call", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    state = { head: "b".repeat(40), clean: true };
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records nothing when the clone cannot be read, and for a repo with no checks", async () => {
    state = null;
    const r = recorder();
    await r.begin(KEY, LINT);
    await r.end(KEY, true);
    state = { head: HEAD, clean: true };
    checks = [];
    await r.begin(KEY, LINT);
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records an end once, ignores an end it never saw begin, and forgets a dropped run", async () => {
    const r = recorder();
    await r.end(KEY, true);
    await r.begin(KEY, LINT);
    await r.end(KEY, true);
    await r.end(KEY, true);
    expect(rows).toHaveLength(1);
    await r.begin(KEY, LINT);
    r.dropRun("r1");
    await r.end(KEY, true);
    expect(rows).toHaveLength(1);
  });

  it("keeps two runs' calls with the same tool id apart", async () => {
    const r = recorder();
    await r.begin({ runId: "r1", toolUseId: "t" }, LINT);
    await r.begin({ runId: "r2", toolUseId: "t" }, LINT);
    await r.end({ runId: "r2", toolUseId: "t" }, true);
    expect(rows.map((x) => x.runId)).toEqual(["r2"]);
  });

  it("never throws when the clone read does", async () => {
    const lines: string[] = [];
    const r = createCheckRecorder({
      store: { addCheckRun: () => {} },
      checks: async () => CHECKS,
      state: async () => {
        throw new Error("boom");
      },
      log: (l) => void lines.push(l),
    });
    await r.begin(KEY, LINT);
    expect(lines).toHaveLength(1);
  });
});

describe("cloneState", () => {
  let dir: string;
  let clone: string;
  let wt: string;
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd,
      encoding: "utf8",
    });
  const config = () =>
    ({
      crew: { sessions: [{ checkout: clone, seats: [{ id: "guido-1" }] }] },
    }) as unknown as Parameters<typeof cloneState>[0];
  const store = (worktree: string | null) =>
    ({
      run: () => ({ agentId: "guido-1" }),
      seatSession: () => ({ worktree }),
    }) as unknown as Parameters<typeof cloneState>[1];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-checks-")));
    clone = join(dir, "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    writeFileSync(join(clone, "a.txt"), "a\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "init");
    wt = join(dir, "wt");
    git(clone, "worktree", "add", "-q", "-b", "feature/1-x", wt);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the worktree's head and whether tracked files are clean", async () => {
    const head = git(wt, "rev-parse", "HEAD").trim();
    expect(await cloneState(config(), store(wt))("r")).toEqual({ head, clean: true });
    writeFileSync(join(wt, "a.txt"), "changed\n");
    expect(await cloneState(config(), store(wt))("r")).toEqual({ head, clean: false });
  });

  it("counts an untracked file as dirty, as the commit tool does", async () => {
    writeFileSync(join(wt, "new.txt"), "n\n");
    expect((await cloneState(config(), store(wt))("r"))?.clean).toBe(false);
  });

  it("is null for a seat with no worktree or a path that is no worktree of the clone", async () => {
    expect(await cloneState(config(), store(null))("r")).toBeNull();
    expect(await cloneState(config(), store(dir))("r")).toBeNull();
  });
});
