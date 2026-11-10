import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_BASH_TIMEOUT_MS } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CloneState,
  checksRun,
  cloneState,
  createCheckRecorder,
  lockedCheck,
  testCommand,
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

describe("lockedCheck", () => {
  it("names a configured check the command runs, alone or in a chain", () => {
    expect(lockedCheck(TYPES, CHECKS)).toBe(TYPES);
    expect(lockedCheck(`  ${LINT}  `, CHECKS)).toBe(LINT);
    expect(lockedCheck(`cd x && ${TYPES}`, CHECKS)).toBe(TYPES);
    expect(lockedCheck(`${LINT} | tail`, CHECKS)).toBe(LINT);
    expect(lockedCheck(`${LINT}; true`, CHECKS)).toBe(LINT);
  });

  it.each([
    ["an output redirection", `${TYPES} > /tmp/typecheck.log`],
    ["a 2>&1 redirection", `${TYPES} 2>&1`],
    ["the command builtin", `command ${TYPES}`],
    ["env", `env FOO=1 ${TYPES}`],
    ["extra spaces", "pnpm  -s   typecheck"],
  ])("names the check behind %s", (_n, command) => {
    expect(lockedCheck(command, CHECKS)).toBe(TYPES);
  });

  it("names nothing for a command that only mentions or extends a check", () => {
    expect(lockedCheck("echo pnpm -s lint", CHECKS)).toBeNull();
    expect(lockedCheck("pnpm -s lint --fix", CHECKS)).toBeNull();
    expect(lockedCheck("ls", CHECKS)).toBeNull();
    expect(lockedCheck(LINT, [])).toBeNull();
  });
});

describe("testCommand", () => {
  it.each([
    "pnpm -s test apps/server/test/guard.test.ts",
    "pnpm -s vitest run x.test.ts",
    "vitest run x.test.ts",
  ])("recognises %s", (command) => expect(testCommand(command)).toBe(true));

  it("does not mistake a command that mentions tests for one that runs them", () => {
    expect(testCommand("echo pnpm -s test")).toBe(false);
  });
});

describe("the check recorder", () => {
  const HEAD = "a".repeat(40);
  const KEY = { runId: "r1", toolUseId: "t1" };
  const WORKTREE = "/work/trees/guido-1-9";
  let rows: {
    runId: string;
    command: string;
    invokedCommand?: string | undefined;
    headSha: string;
    ok: boolean;
    at: number;
  }[];
  let state: CloneState | null;
  let checks: readonly string[];
  const recorder = () =>
    createCheckRecorder({
      store: { addCheckRun: (c) => void rows.push(c) },
      checks: async () => checks,
      state: async () => state,
      worktree: async () => WORKTREE,
      now: () => 99,
    });

  beforeEach(() => {
    rows = [];
    state = { head: HEAD, clean: true };
    checks = CHECKS;
  });

  it("records a plain lint and typecheck call from Claude on the clean head it started on", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    await r.end(KEY, true);
    expect(rows).toEqual([
      {
        runId: "r1",
        command: LINT,
        invokedCommand: `${LINT} && ${TYPES}`,
        headSha: HEAD,
        ok: true,
        exitCode: null,
        at: 99,
      },
      {
        runId: "r1",
        command: TYPES,
        invokedCommand: `${LINT} && ${TYPES}`,
        headSha: HEAD,
        ok: true,
        exitCode: null,
        at: 99,
      },
    ]);
  });

  it("records a plain lint and typecheck call when Codex completes it by its item id", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`, [{ runId: "r1", toolUseId: "codex-item-1" }]);
    await r.end({ runId: "r1", toolUseId: "codex-item-1" }, true);
    expect(rows).toEqual([
      {
        runId: "r1",
        command: LINT,
        invokedCommand: `${LINT} && ${TYPES}`,
        headSha: HEAD,
        ok: true,
        exitCode: null,
        at: 99,
      },
      {
        runId: "r1",
        command: TYPES,
        invokedCommand: `${LINT} && ${TYPES}`,
        headSha: HEAD,
        ok: true,
        exitCode: null,
        at: 99,
      },
    ]);
  });

  it("keeps aliased checks pending until their completion is recorded", async () => {
    let finishState: ((state: CloneState | null) => void) | undefined;
    let readingEnd = false;
    const r = createCheckRecorder({
      store: { addCheckRun: (row) => void rows.push(row) },
      checks: async () => CHECKS,
      state: async () =>
        readingEnd
          ? new Promise<CloneState | null>((resolve) => {
              finishState = resolve;
            })
          : state,
    });
    const alias = { runId: "r1", toolUseId: "codex-item" };
    await r.begin(KEY, `${LINT} && ${TYPES}`, [alias]);
    expect(r.pending("r1")).toEqual([LINT, TYPES]);
    expect(r.pending("other-run")).toEqual([]);
    readingEnd = true;
    const ending = r.end(alias, true, 0);
    expect(r.pending("r1")).toEqual([LINT, TYPES]);
    r.dropRun("r1", { keepWatching: true }); // A normal Codex hand-back keeps its receipt alive.
    expect(r.pending("r1")).toEqual([LINT, TYPES]);
    finishState?.(state);
    await ending;
    expect(r.pending("r1")).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(r.drops("r1")).toEqual([]);
  });

  it("clears pending checks when completion validation cannot read the clone", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    state = null;
    await r.end(KEY, true, 0);
    expect(r.pending("r1")).toEqual([]);
    expect(rows).toEqual([]);
    expect(r.drops("r1")).toMatchObject([{ reason: "unreadable", command: LINT }]);
  });

  it.each([
    ["&&", `cd ${WORKTREE} && ${LINT}`],
    [";", `cd ${WORKTREE}; ${LINT}`],
    ["; with a trailing slash", `cd ${WORKTREE}/; ${LINT}`],
    ["a quoted path", `cd "${WORKTREE}" && ${LINT}`],
  ])("counts a check run after a cd into the seat's own worktree with %s", async (_n, command) => {
    const r = recorder();
    await r.begin(KEY, command);
    await r.end(KEY, true);
    expect(rows.map((x) => [x.command, x.invokedCommand, x.headSha])).toEqual([
      [LINT, command, HEAD],
    ]);
  });

  it.each([
    ["a cd into another path", `cd /work/trees/other; ${LINT}`],
    ["a cd into another path with &&", `cd /work/trees/other && ${LINT}`],
    ["a cd into a sibling that shares the prefix", `cd ${WORKTREE}-2; ${LINT}`],
    ["a cd into a subdirectory", `cd ${WORKTREE}/apps && ${LINT}`],
    ["a sleep", `sleep 1; ${LINT}`],
    ["a pipe", `${LINT} | tee x`],
    ["a cd and then a second command", `cd ${WORKTREE}; true; ${LINT}`],
    ["a cd and a check followed by another command", `cd ${WORKTREE}; ${LINT}; true`],
    ["a cd and a pipe", `cd ${WORKTREE}; ${LINT} | tee x`],
    ["a cd after the check", `${LINT}; cd ${WORKTREE}`],
    ["a cd and an or", `cd ${WORKTREE} || ${LINT}`],
    ["a cd to a variable", `cd $HOME; ${LINT}`],
  ])("does not count a check run after %s", async (_n, command) => {
    const r = recorder();
    await r.begin(KEY, command);
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("counts nothing after a cd when the worktree is unknown", async () => {
    const r = createCheckRecorder({
      store: { addCheckRun: (c) => void rows.push(c) },
      checks: async () => CHECKS,
      state: async () => state,
      worktree: async () => null,
      now: () => 99,
    });
    await r.begin(KEY, `cd ${WORKTREE}; ${LINT}`);
    await r.end(KEY, true);
    expect(rows).toEqual([]);
  });

  it("records a failed call as ok = false", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    await r.end(KEY, false);
    expect(rows.map((x) => x.ok)).toEqual([false]);
  });

  it("keeps a chained invocation and Codex's numeric failure exit", async () => {
    const detailed: unknown[] = [];
    const r = createCheckRecorder({
      store: { addCheckRun: (c) => void detailed.push(c) },
      checks: async () => CHECKS,
      state: async () => state,
      now: () => 99,
    });
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    await r.end(KEY, false, 2);
    expect(detailed).toEqual([
      {
        runId: "r1",
        command: LINT,
        invokedCommand: `${LINT} && ${TYPES}`,
        headSha: HEAD,
        ok: false,
        exitCode: 2,
        at: 99,
      },
      {
        runId: "r1",
        command: TYPES,
        invokedCommand: `${LINT} && ${TYPES}`,
        headSha: HEAD,
        ok: false,
        exitCode: 2,
        at: 99,
      },
    ]);
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

  it("records an end once, ignores an end it never saw begin, and keeps watching after a turn ends", async () => {
    const r = recorder();
    await r.end(KEY, true);
    await r.begin(KEY, LINT);
    await r.end(KEY, true);
    await r.end(KEY, true);
    expect(rows).toHaveLength(1);
    await r.begin(KEY, LINT);
    r.dropRun("r1", { keepWatching: true });
    await r.end(KEY, true);
    expect(rows).toHaveLength(2);
  });

  it("releases an interrupted call so another check can be admitted", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    r.dropRun("r1");
    expect(await r.admit?.({ runId: "r1", toolUseId: "t2" }, TYPES)).toBeNull();
    expect(r.drops("r1")).toMatchObject([{ reason: "turn-ended", command: LINT }]);
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

  it("names the check a call must take the test lock for, and records nothing for a call that waited", async () => {
    const r = recorder();
    expect(await r.lockedBy("r1", TYPES)).toBe(TYPES);
    expect(await r.lockedBy("r1", "ls")).toBeNull();
    // refused while another seat held the lock: it began but never ended, so no failed row
    await r.begin(KEY, TYPES);
    expect(rows).toEqual([]);
  });

  it("names the running test before another test can start in the same checkout", async () => {
    const r = recorder();
    await r.begin(KEY, "pnpm -s test apps/server/test/guard.test.ts");
    expect(await r.running?.("r1", "vitest run apps/server/test/guard.test.ts")).toBe(
      "pnpm -s test apps/server/test/guard.test.ts",
    );
    await r.end(KEY, true, 0);
  });

  it("atomically refuses a second check admission in the same checkout", async () => {
    const r = recorder();
    const other = { runId: "r1", toolUseId: "t2" };
    const admissions = await Promise.all([r.admit?.(KEY, LINT), r.admit?.(other, TYPES)]);
    expect(admissions.filter((admission) => admission === null)).toHaveLength(1);
    expect(admissions.filter((admission) => admission !== null)).toEqual([LINT]);
    const winner = admissions[0] === null ? KEY : other;
    await r.begin(winner, winner === KEY ? LINT : TYPES);
    await r.end(winner, true, 0);
  });

  it.each([
    ["dirty", { head: HEAD, clean: false } as CloneState, {}],
    ["unreadable", null, {}],
    ["background", { head: HEAD, clean: true } as CloneState, { background: true }],
  ])(
    "keeps a %s test execution exclusive although it cannot earn a receipt",
    async (_n, start, options) => {
      const r = recorder();
      state = start;
      await r.begin(KEY, "pnpm -s test apps/server/test/guard.test.ts", [], options);
      expect(await r.admit?.({ runId: "r1", toolUseId: "t2" }, LINT)).toBe(
        "pnpm -s test apps/server/test/guard.test.ts",
      );
      state = { head: HEAD, clean: true };
      await r.end(KEY, true, 0);
      expect(rows).toEqual([]);
    },
  );

  it("takes no lock when the repo's rules cannot be read", async () => {
    const lines: string[] = [];
    const r = createCheckRecorder({
      store: { addCheckRun: () => {} },
      checks: async () => {
        throw new Error("no rules");
      },
      state: async () => state,
      log: (l) => void lines.push(l),
    });
    expect(await r.lockedBy("r1", TYPES)).toBeNull();
    expect(lines).toHaveLength(1);
  });
});

describe("why the recorder dropped a check call", () => {
  const HEAD = "a".repeat(40);
  const KEY = { runId: "r1", toolUseId: "t1" };
  let rows: unknown[];
  let state: CloneState | null;
  let clock: number;
  const recorder = () =>
    createCheckRecorder({
      store: { addCheckRun: (c) => void rows.push(c) },
      checks: async () => CHECKS,
      state: async () => state,
      now: () => clock,
    });
  const reasons = (r: ReturnType<typeof recorder>) =>
    r.drops("r1").map((d) => [d.reason, d.command, d.head]);

  beforeEach(() => {
    rows = [];
    state = { head: HEAD, clean: true };
    clock = 1_000;
  });

  it("records a passing call that ran past two minutes in the foreground", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    clock += 5 * 60_000;
    await r.end(KEY, true);
    expect(rows).toHaveLength(2);
    expect(r.drops("r1")).toEqual([]);
  });

  it("says a check chained with a pipe, ||, ; or a line break was not counted", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} | tail`);
    expect(r.drops("r1")).toEqual([
      { reason: "not-plain", command: LINT, head: HEAD, invoked: `${LINT} | tail`, at: 1_000 },
    ]);
  });

  it("says nothing for a call that runs no configured check", async () => {
    const r = recorder();
    await r.begin(KEY, "ls | tail");
    expect(r.drops("r1")).toEqual([]);
  });

  it("says a check started on a dirty tree", async () => {
    state = { head: HEAD, clean: false };
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    expect(reasons(r)).toEqual([
      ["dirty-start", LINT, HEAD],
      ["dirty-start", TYPES, HEAD],
    ]);
  });

  it("says a check left the tree dirty", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    state = { head: HEAD, clean: false };
    await r.end(KEY, true);
    expect(reasons(r)).toEqual([["dirty-end", LINT, HEAD]]);
    expect(rows).toEqual([]);
  });

  it("says the head moved during a check, keyed by the head it started on", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    state = { head: "b".repeat(40), clean: true };
    await r.end(KEY, true);
    expect(reasons(r)).toEqual([["head-moved", LINT, HEAD]]);
  });

  it("keeps watching a check when the tool hands back early", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    r.dropRun("r1", { keepWatching: true });
    await r.end(KEY, true, 0);
    expect(rows).toMatchObject([
      { command: LINT, headSha: HEAD, ok: true, exitCode: 0 },
      { command: TYPES, headSha: HEAD, ok: true, exitCode: 0 },
    ]);
    expect(reasons(r)).toEqual([]);
  });

  it("marks an early-returned check stale when HEAD changes before it exits", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    r.dropRun("r1", { keepWatching: true });
    state = { head: "b".repeat(40), clean: true };
    await r.end(KEY, true, 0);
    expect(rows).toEqual([]);
    expect(reasons(r)).toEqual([["head-moved", LINT, HEAD]]);
  });

  it("says a check moved to the background", async () => {
    const r = recorder();
    await r.begin(KEY, LINT, [], { background: true });
    await r.end(KEY, true);
    expect(reasons(r)).toEqual([["background", LINT, HEAD]]);
    expect(rows).toEqual([]);
  });

  it("says a failed call with no exit code that ran to its Bash timeout was killed by it", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    clock += 120_000;
    await r.end(KEY, false);
    expect(reasons(r)).toEqual([["timeout", LINT, HEAD]]);
    // the failure is recorded too; the note says why it has no exit code
    expect(rows).toHaveLength(1);
  });

  it("uses the call's own Bash timeout, and says nothing of a fast failure", async () => {
    const r = recorder();
    await r.begin(KEY, LINT, [], { timeoutMs: 600_000 });
    clock += 130_000;
    await r.end(KEY, false);
    expect(r.drops("r1")).toEqual([]);
    await r.begin({ runId: "r1", toolUseId: "t2" }, LINT);
    clock += 3_000;
    await r.end({ runId: "r1", toolUseId: "t2" }, false);
    expect(r.drops("r1")).toEqual([]);
  });

  describe("a check that runs past ten minutes", () => {
    const LONG = 11 * 60_000;
    const options = { timeoutMs: CHECK_BASH_TIMEOUT_MS };

    it("counts it when it exits 0 on the clean commit it started on", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], options);
      clock += LONG;
      await r.end(KEY, true);
      expect(rows).toMatchObject([{ command: LINT, headSha: HEAD, ok: true }]);
      expect(r.drops("r1")).toEqual([]);
    });

    it("does not count a call the CLI stopped at the limit", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], options);
      clock += CHECK_BASH_TIMEOUT_MS;
      await r.end(KEY, false);
      expect(rows).toMatchObject([{ ok: false, exitCode: null }]);
      expect(reasons(r)).toEqual([["timeout", LINT, HEAD]]);
    });

    it("reads a longer timeout as the limit the CLI cuts it to", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], { timeoutMs: 2 * CHECK_BASH_TIMEOUT_MS });
      clock += CHECK_BASH_TIMEOUT_MS;
      await r.end(KEY, false);
      expect(reasons(r)).toEqual([["timeout", LINT, HEAD]]);
    });

    it("does not count a real failure, and gives it no timeout reason", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], options);
      clock += LONG;
      await r.end(KEY, false, 1);
      expect(rows).toMatchObject([{ ok: false, exitCode: 1 }]);
      expect(r.drops("r1")).toEqual([]);
    });

    it("does not count it when the head moved or the tree changed", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], options);
      clock += LONG;
      state = { head: "b".repeat(40), clean: true };
      await r.end(KEY, true);
      expect(reasons(r)).toEqual([["head-moved", LINT, HEAD]]);
      state = { head: HEAD, clean: true };
      await r.begin({ runId: "r1", toolUseId: "t2" }, LINT, [], options);
      clock += LONG;
      state = { head: HEAD, clean: false };
      await r.end({ runId: "r1", toolUseId: "t2" }, true);
      expect(reasons(r)).toContainEqual(["dirty-end", LINT, HEAD]);
      expect(rows).toEqual([]);
    });

    it("does not count a background call or invent a result whose end the hub never saw", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], { ...options, background: true });
      clock += LONG;
      await r.end(KEY, true);
      expect(reasons(r)).toEqual([["background", LINT, HEAD]]);
      await r.begin({ runId: "r1", toolUseId: "t2" }, LINT, [], options);
      clock += LONG;
      r.dropRun("r1", { keepWatching: true });
      expect(reasons(r)).toEqual([["background", LINT, HEAD]]);
      expect(rows).toEqual([]);
    });
  });

  it("says the clone could not be read", async () => {
    state = null;
    const r = recorder();
    await r.begin(KEY, LINT);
    expect(reasons(r)).toEqual([["unreadable", LINT, null]]);
  });

  it("keeps watching after a drop and keeps runs apart", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    r.dropRun("r1", { keepWatching: true });
    expect(r.drops("r1")).toEqual([]);
    await r.begin({ runId: "r1", toolUseId: "t2" }, LINT);
    await r.end({ runId: "r1", toolUseId: "t2" }, true);
    expect(r.drops("r1")).toEqual([]);
    await r.begin({ runId: "r2", toolUseId: "t" }, `${LINT} | x`);
    expect(r.drops("r1")).toEqual([]);
    expect(r.drops("r2")).toHaveLength(1);
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
