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
} from "../src/guard/check-runs.ts";

const LINT = "pnpm -s lint";
const TYPES = "pnpm -s typecheck";
const RELATED = "pnpm -s test:related";
const CHECKS = [LINT, TYPES];

describe("checksRun", () => {
  it("matches a check that is one && segment exactly, after trimming", () => {
    expect(checksRun(LINT, CHECKS)).toEqual([LINT]);
    expect(checksRun(`  ${LINT}  `, CHECKS)).toEqual([LINT]);
    expect(checksRun(`${LINT} && ${TYPES}`, CHECKS)).toEqual([LINT, TYPES]);
  });

  it("matches configured checks when related tests are another && segment", () => {
    expect(checksRun(`${LINT} && ${TYPES} && pnpm -s test:related`, CHECKS)).toEqual([LINT, TYPES]);
  });

  it("matches nothing when related tests are not last", () => {
    expect(checksRun(`pnpm -s test:related && ${LINT}`, CHECKS)).toEqual([]);
  });

  it("keeps related tests as a configured check when it runs alone", () => {
    expect(checksRun(RELATED, [LINT, RELATED])).toEqual([RELATED]);
  });

  it("keeps related tests as a configured check when it ends a chain", () => {
    expect(checksRun(`${LINT} && ${RELATED}`, [LINT, RELATED])).toEqual([LINT, RELATED]);
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

  it("names the related-tests check for its other spellings, which load the Mac the same", () => {
    const RELATED = "pnpm -s test:related";
    const checks = [LINT, RELATED];
    for (const command of [
      "pnpm test:related",
      "pnpm run test:related",
      "pnpm -s run test:related",
      "node --experimental-strip-types scripts/check-related.ts",
      `cd x && pnpm run test:related | tail`,
    ]) {
      expect(lockedCheck(command, checks), command).toBe(RELATED);
    }
    expect(lockedCheck("pnpm run lint", checks)).toBe(LINT);
  });

  it("takes no lock for a single test file or another script", () => {
    const checks = [LINT, "pnpm -s test:related"];
    expect(lockedCheck("pnpm -s vitest run apps/server/test/a.test.ts", checks)).toBeNull();
    expect(lockedCheck("pnpm test:related:other", checks)).toBeNull();
    expect(lockedCheck("pnpm run test:related --foo", checks)).toBeNull();
    expect(lockedCheck("echo pnpm run test:related", checks)).toBeNull();
  });

  it("names nothing for a command that only mentions or extends a check", () => {
    expect(lockedCheck("echo pnpm -s lint", CHECKS)).toBeNull();
    expect(lockedCheck("pnpm -s lint --fix", CHECKS)).toBeNull();
    expect(lockedCheck("ls", CHECKS)).toBeNull();
    expect(lockedCheck(LINT, [])).toBeNull();
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

  it("records configured checks when related tests finish the plain chain", async () => {
    const r = recorder();
    const command = `${LINT} && ${TYPES} && pnpm -s test:related`;
    await r.begin(KEY, command);
    await r.end(KEY, true, 0);
    expect(rows).toMatchObject([
      { command: LINT, invokedCommand: command, headSha: HEAD, ok: true, exitCode: 0 },
      { command: TYPES, invokedCommand: command, headSha: HEAD, ok: true, exitCode: 0 },
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
    r.dropRun("r1"); // A turn ending while the completed receipt is checked must not discard it.
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

  it("records no passing configured check when the related-tests chain fails", async () => {
    const r = recorder();
    const command = `${LINT} && ${TYPES} && pnpm -s test:related`;
    await r.begin(KEY, command);
    await r.end(KEY, false, 1);
    expect(rows).toMatchObject([
      { command: LINT, invokedCommand: command, headSha: HEAD, ok: false, exitCode: null },
      { command: TYPES, invokedCommand: command, headSha: HEAD, ok: false, exitCode: null },
    ]);
  });

  it("records nothing when related tests precede a configured check", async () => {
    const r = recorder();
    const command = `pnpm -s test:related && ${LINT}`;
    await r.begin(KEY, command);
    await r.end(KEY, false, 1);
    expect(rows).toEqual([]);
  });

  it("records a configured related-tests check with its real failure exit", async () => {
    checks = [LINT, RELATED];
    const r = recorder();
    const command = `${LINT} && ${RELATED}`;
    await r.begin(KEY, command);
    await r.end(KEY, false, 1);
    expect(rows).toMatchObject([
      { command: LINT, invokedCommand: command, headSha: HEAD, ok: false, exitCode: 1 },
      { command: RELATED, invokedCommand: command, headSha: HEAD, ok: false, exitCode: 1 },
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

  it.each([
    `${LINT} && pnpm -s test:related | tail`,
    `${LINT} && pnpm -s test:related; echo done`,
    `${LINT} && sleep 1 && pnpm -s test:related`,
  ])("does not count a related-tests chain with another command: %j", async (command) => {
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

  it("names only the related-tests check as one that takes the test lock", () => {
    const r = recorder();
    expect(r.lockedBy("pnpm -s test:related")).toBe("pnpm -s test:related");
    expect(r.lockedBy("pnpm run test:related")).toBe("pnpm -s test:related");
    expect(r.lockedBy(`${LINT} && pnpm -s test:related`)).toBe("pnpm -s test:related");
    expect(r.lockedBy(TYPES)).toBeNull();
    expect(r.lockedBy(LINT)).toBeNull();
    expect(r.lockedBy("ls")).toBeNull();
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

  it("reserves the checkout for one check or test at a time, vitest and pnpm test included", async () => {
    let t = 1_000;
    const r = createCheckRecorder({
      store: { addCheckRun: (row) => void rows.push(row) },
      checks: async () => CHECKS,
      state: async () => state,
      now: () => t,
    });
    const key = (id: string) => ({ runId: "r1", toolUseId: id });
    expect(await r.admit?.(key("t0"), "ls")).toBeNull();
    // two parallel requests: exactly one gets the checkout
    const both = await Promise.all([r.admit?.(key("t1"), LINT), r.admit?.(key("t2"), TYPES)]);
    expect(both).toEqual([null, LINT]);
    expect(await r.admit?.(key("t3"), "pnpm -s vitest run a.test.ts")).toBe(LINT);
    expect(await r.admit?.({ runId: "r2", toolUseId: "o" }, TYPES)).toBeNull(); // another run's checkout is free
    r.release?.(key("t1"));
    // a vitest run, not a receipt check, holds the checkout as well
    expect(await r.admit?.(key("t4"), "pnpm -s vitest run a.test.ts")).toBeNull();
    expect(await r.admit?.(key("t5"), TYPES)).toBe("pnpm -s vitest run a.test.ts");
    await r.end(key("t4"), true, 0);
    expect(await r.admit?.(key("t6"), "pnpm -s test")).toBeNull();
    expect(await r.admit?.(key("t7"), LINT)).toBe("pnpm -s test");
    r.dropRun("r1");
    expect(await r.admit?.(key("t8"), LINT)).toBeNull();
    t += CHECK_BASH_TIMEOUT_MS + 1_000; // past its own timeout, a call is gone
    expect(await r.admit?.(key("t9"), TYPES)).toBeNull();
  });

  describe("a check whose tool handed back before its process ended", () => {
    const WORKTREE = "/work/trees/guido-1-9";
    const watching = (alive: { now: boolean }) =>
      createCheckRecorder({
        store: { addCheckRun: (row) => void rows.push(row) },
        checks: async () => CHECKS,
        state: async () => state,
        worktree: async () => WORKTREE,
        processAlive: async () => alive.now,
        pollMs: 5,
      });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("frees an admitted check that never starts after one watcher poll", async () => {
      const r = watching({ now: false });
      await r.admit?.(KEY, LINT);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBe(LINT);
      await wait(20);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBeNull();
    });

    it("keeps the checkout reserved and records the late exit against the start commit", async () => {
      const alive = { now: true };
      const r = watching(alive);
      await r.admit?.(KEY, LINT);
      await r.begin(KEY, LINT);
      r.dropRun("r1"); // the turn ended; the process still runs
      await wait(20);
      expect(r.pending("r1")).toEqual([LINT]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBe(LINT);
      await r.end(KEY, true, 0);
      expect(rows).toMatchObject([{ command: LINT, headSha: HEAD, ok: true, exitCode: 0 }]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBeNull();
    });

    it("keeps a vitest or pnpm test hold while its process runs, and frees it when it is gone", async () => {
      const alive = { now: true };
      const r = watching(alive);
      const test = "pnpm -s test";
      await r.admit?.(KEY, test);
      r.dropRun("r1"); // not a receipt check: no started call, only the reservation
      await wait(20);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, test)).toBe(test);
      alive.now = false;
      await wait(40);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, test)).toBeNull();
    });

    it("keeps the checkout when a completion has no exit code while the process runs", async () => {
      const alive = { now: true };
      const r = watching(alive);
      await r.admit?.(KEY, LINT);
      await r.begin(KEY, LINT);
      await r.end(KEY, false);
      expect(rows).toEqual([]);
      expect(r.pending("r1")).toEqual([LINT]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBe(LINT);
      await wait(20);
      alive.now = false;
      await wait(40);
      expect(reasons(r)).toEqual([["session-lost", LINT, HEAD]]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBeNull();
    });

    it("notes a timeout at once for a call past its Bash timeout, and keeps the checkout while it runs", async () => {
      let t = 1_000;
      const alive = { now: true };
      const r = createCheckRecorder({
        store: { addCheckRun: (row) => void rows.push(row) },
        checks: async () => CHECKS,
        state: async () => state,
        worktree: async () => "/work/trees/guido-1-9",
        processAlive: async () => alive.now,
        pollMs: 5,
        now: () => t,
      });
      await r.admit?.(KEY, LINT);
      await r.begin(KEY, LINT);
      t += 120_000;
      await r.end(KEY, false);
      expect(rows).toEqual([]);
      expect(reasons(r)).toEqual([["timeout", LINT, HEAD]]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBe(LINT);
      alive.now = false;
      await wait(40);
      expect(reasons(r)).toEqual([["timeout", LINT, HEAD]]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBeNull();
    });

    it("records no receipt when the head moved before the late exit", async () => {
      const r = watching({ now: true });
      await r.begin(KEY, LINT);
      r.dropRun("r1");
      state = { head: "b".repeat(40), clean: true };
      await r.end(KEY, true, 0);
      expect(rows).toEqual([]);
      expect(reasons(r)).toEqual([["head-moved", LINT, HEAD]]);
    });

    it("frees the checkout and says so when the process ends with no completion", async () => {
      const alive = { now: true };
      const r = watching(alive);
      await r.admit?.(KEY, LINT);
      await r.begin(KEY, LINT);
      r.dropRun("r1");
      await wait(20);
      alive.now = false;
      await wait(40);
      expect(r.pending("r1")).toEqual([]);
      expect(reasons(r)).toEqual([["session-lost", LINT, HEAD]]);
      expect(await r.admit?.({ runId: "r1", toolUseId: "retry" }, LINT)).toBeNull();
    });
  });

  it("says the turn ended before a check reported its end", async () => {
    const r = recorder();
    await r.begin(KEY, `${LINT} && ${TYPES}`);
    r.dropRun("r1");
    expect(reasons(r)).toEqual([
      ["turn-ended", LINT, HEAD],
      ["turn-ended", TYPES, HEAD],
    ]);
  });

  it("says a check moved to the background", async () => {
    const r = recorder();
    await r.begin(KEY, LINT, [], { background: true });
    await r.end(KEY, true);
    expect(reasons(r)).toEqual([["background", LINT, HEAD]]);
    expect(rows).toEqual([]);
  });

  it("replaces a Codex check whose session disappeared with a fresh run in the same turn", async () => {
    const r = recorder();
    const joined = `${LINT} && ${TYPES}`;
    await r.begin(KEY, joined, [{ runId: "r1", toolUseId: "codex-item-1" }]);
    expect(r.pending("r1")).toEqual([LINT, TYPES]);
    expect(r.lost("r1", LINT)).toBe(true);
    expect(r.pending("r1")).toEqual([]);
    expect(reasons(r)).toEqual([
      ["session-lost", LINT, HEAD],
      ["session-lost", TYPES, HEAD],
    ]);

    const fresh = { runId: "r1", toolUseId: "codex-item-2" };
    await r.begin(fresh, joined, [{ runId: "r1", toolUseId: "codex-item-3" }]);

    expect(r.pending("r1")).toEqual([LINT, TYPES]);
    await r.end({ runId: "r1", toolUseId: "codex-item-3" }, true, 0);

    expect(rows).toMatchObject([
      { command: LINT, headSha: HEAD, ok: true, exitCode: 0 },
      { command: TYPES, headSha: HEAD, ok: true, exitCode: 0 },
    ]);
    expect(r.pending("r1")).toEqual([]);
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

    it("does not count a background call or one whose end the hub never saw", async () => {
      const r = recorder();
      await r.begin(KEY, LINT, [], { ...options, background: true });
      clock += LONG;
      await r.end(KEY, true);
      expect(reasons(r)).toEqual([["background", LINT, HEAD]]);
      await r.begin({ runId: "r1", toolUseId: "t2" }, LINT, [], options);
      clock += LONG;
      r.dropRun("r1");
      expect(reasons(r)).toContainEqual(["turn-ended", LINT, HEAD]);
      expect(rows).toEqual([]);
    });
  });

  it("says the clone could not be read", async () => {
    state = null;
    const r = recorder();
    await r.begin(KEY, LINT);
    expect(reasons(r)).toEqual([["unreadable", LINT, null]]);
  });

  it("forgets a drop once the check passes on that head, and keeps runs apart", async () => {
    const r = recorder();
    await r.begin(KEY, LINT);
    r.dropRun("r1");
    expect(r.drops("r1")).toHaveLength(1);
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
