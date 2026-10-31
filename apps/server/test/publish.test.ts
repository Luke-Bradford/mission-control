import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AWAY_SETTING,
  AWAY_WRITES_REFUSED,
  CI_EXCERPT_LINES,
  CI_EXCERPT_MAX,
  DEFAULT_AWAY,
  EVIDENCE_HEADING,
  MC_PR_BODY_MAX,
  MC_PR_BODY_REFUSED,
  MC_PR_EDIT_FAILED,
  MC_PR_FAILED,
  MC_PUSH_FAILED,
  MC_PUSH_FIRST,
  MINOR_HEADING,
  MINOR_WITHHELD,
  minorIntro,
  minorMoreLine,
  NEW_LOOP,
  prEditedText,
  type Run,
  STDERR_TEXT_MAX,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import {
  CI_LOG_UNREADABLE,
  cleanLog,
  createPublisher,
  EARLIER_PR_OPEN,
  EMPTY_LOG,
  MERGE_CONFLICTING,
  MERGE_HEAD_MOVED,
  MERGE_PR_NOT_RUNS,
  NO_FAILED_RUN,
  READY_UNDO_FAILED,
  REVIEW_STATUS_FAILED,
} from "../src/engine/publish.ts";
import { createGh, type GhRunner } from "../src/mcp/gh.ts";
import { editRunPrBody, type McToolsDeps } from "../src/mcp/tools.ts";
import { setRunPathGrants } from "../src/path-grants.ts";
import { Store } from "../src/store.ts";

const tools = vi.hoisted(() => ({
  pushRun: vi.fn(),
  openDraftPr: vi.fn(),
}));
vi.mock("../src/mcp/tools.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mcp/tools.ts")>()),
  pushRun: tools.pushRun,
  openDraftPr: tools.openDraftPr,
}));

const START = Date.parse("2026-10-21T10:00:00Z");
const BRANCH = "feature/7-fix-the-thing";
const SHA = "a".repeat(40);
const BASE = "c".repeat(40);

let dir: string;
let store: Store;
let ghCalls: string[][];
type GhAnswer = { code: number | null; stdout: string; stderr?: string };
let ghAnswers: ((args: string[]) => GhAnswer | Promise<GhAnswer>)[];

const config = (): CcConfig =>
  ({
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [],
    repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 8,
      sessions: [
        {
          id: "s",
          repoId: "mc",
          checkout: join(dir, "clone"),
          seats: [{ id: "guido-1", role: "GUIDO", accountId: "a", model: "haiku", area: [] }],
        },
      ],
    },
  }) as CcConfig;

const gh: GhRunner = async (args) => {
  ghCalls.push(args);
  const answer = ghAnswers.shift();
  if (answer === undefined) throw new Error(`gh ${args.join(" ")} was not expected`);
  const r = await answer(args);
  return { stderr: "", ...r };
};

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: START,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: BRANCH,
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const deps = (over: Partial<McToolsDeps> = {}): McToolsDeps => ({
  config: config(),
  store,
  bus: { emit: () => {} } as never,
  inClone: (_c, fn) => fn(),
  gh,
  dbPath: join(dir, "mc.sqlite"),
  knownSecrets: async () => [],
  checks: async () => [],
  ...over,
});

const list =
  (...prs: { number: number; createdAt: string }[]) =>
  () => ({
    code: 0,
    stdout: JSON.stringify(prs),
  });
const TICKET = { issue: 7, title: "Fix the thing" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-publish-"));
  store = new Store(join(dir, "mc.sqlite"));
  ghCalls = [];
  ghAnswers = [];
  tools.pushRun.mockReset();
  tools.openDraftPr.mockReset();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("push", () => {
  it("counts already-on-origin and nothing-to-push as success", async () => {
    const p = createPublisher(deps());
    tools.pushRun.mockResolvedValueOnce({ text: "Already on origin." });
    tools.pushRun.mockResolvedValueOnce({ text: "Nothing to push." });
    expect(await p.push(run())).toEqual({ ok: true });
    expect(await p.push(run())).toEqual({ ok: true });
    expect(tools.pushRun).toHaveBeenCalledWith(expect.anything(), "r1");
  });

  it("is transient only for the tool's own failure text", async () => {
    const p = createPublisher(deps());
    tools.pushRun.mockResolvedValueOnce({ text: MC_PUSH_FAILED, isError: true });
    tools.pushRun.mockResolvedValueOnce({ text: "Push refused: the branch moved.", isError: true });
    expect(await p.push(run())).toEqual({ ok: false, text: MC_PUSH_FAILED, transient: true });
    expect(await p.push(run())).toEqual({
      ok: false,
      text: "Push refused: the branch moved.",
      transient: false,
    });
  });
});

describe("openPr", () => {
  const OPENED = "https://github.com/o/mc/pull/31";

  it("opens the PR with the ticket's title and a body with the latest note and the closing line", async () => {
    ghAnswers = [list(), list({ number: 31, createdAt: "2026-10-21T10:30:00Z" })];
    tools.openDraftPr.mockResolvedValueOnce({ text: OPENED });
    const r = await createPublisher(deps()).openPr(run(), TICKET, "Changed it.");
    expect(r).toEqual({ ok: true, prNumber: 31 });
    expect(tools.openDraftPr).toHaveBeenCalledWith(expect.anything(), "r1", {
      title: "#7 Fix the thing",
      body: "#7 — Fix the thing\n\n## What changed\n\nChanged it.\n\nCloses #7.",
    });
  });

  it("cuts a note that would take the body past the limit, and keeps the closing line", async () => {
    ghAnswers = [list()];
    tools.openDraftPr.mockResolvedValueOnce({ text: OPENED });
    await createPublisher(deps()).openPr(run(), TICKET, "x".repeat(MC_PR_BODY_MAX + 500));
    const pr = tools.openDraftPr.mock.calls[0]?.[2] as { title: string; body: string };
    expect(pr.body).toHaveLength(MC_PR_BODY_MAX);
    expect(pr.body.endsWith("…\n\nCloses #7.")).toBe(true);
  });

  it("falls back to the bare issue when the title or body would notify someone", async () => {
    ghAnswers = [list()];
    tools.openDraftPr.mockResolvedValueOnce({ text: OPENED });
    const r = await createPublisher(deps()).openPr(
      run(),
      { issue: 7, title: "Thanks @someone-else for the report" },
      "Changed it.",
    );
    expect(r).toEqual({ ok: true, prNumber: 31 });
    expect(tools.openDraftPr).toHaveBeenCalledWith(expect.anything(), "r1", {
      title: "#7",
      body: "#7\n\n## What changed\n\nChanged it.\n\nCloses #7.",
    });
  });

  it("takes a PR already open on the branch only when it began with this run", async () => {
    ghAnswers = [list({ number: 30, createdAt: "2026-10-21T10:01:00Z" })];
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: true,
      prNumber: 30,
    });
    expect(tools.openDraftPr).not.toHaveBeenCalled();

    ghAnswers = [list({ number: 29, createdAt: "2026-10-20T10:00:00Z" })];
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: false,
      text: EARLIER_PR_OPEN,
      transient: false,
    });
    expect(EARLIER_PR_OPEN).toBe("an earlier PR is open on this branch");
    expect(tools.openDraftPr).not.toHaveBeenCalled();
  });

  it("adopts a recorded PR from an ended earlier run of the same seat and ticket", async () => {
    store.upsertRun(
      run({
        id: "r0",
        startedAt: START - 1_000,
        endedAt: START - 500,
        status: "ok",
        loop: { ...NEW_LOOP, prNumber: 29 },
      }),
    );
    ghAnswers = [list({ number: 29, createdAt: "2026-10-20T10:00:00Z" })];
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: true,
      prNumber: 29,
    });
    expect(tools.openDraftPr).not.toHaveBeenCalled();
  });

  it("does not adopt an earlier PR recorded by another seat", async () => {
    store.upsertRun(
      run({
        id: "r0",
        agentId: "other-seat",
        startedAt: START - 1_000,
        endedAt: START - 500,
        status: "ok",
        loop: { ...NEW_LOOP, prNumber: 29 },
      }),
    );
    ghAnswers = [list({ number: 29, createdAt: "2026-10-20T10:00:00Z" })];
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: false,
      text: EARLIER_PR_OPEN,
      transient: false,
    });
  });

  it("does not adopt a same-seat PR from a run that ended after this one started", async () => {
    store.upsertRun(
      run({
        id: "r0",
        startedAt: START - 1_000,
        endedAt: START + 500,
        status: "ok",
        loop: { ...NEW_LOOP, prNumber: 29 },
      }),
    );
    ghAnswers = [list({ number: 29, createdAt: "2026-10-20T10:00:00Z" })];
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: false,
      text: EARLIER_PR_OPEN,
      transient: false,
    });
  });

  it("is transient when gh cannot list, or the tool's own failure text comes back", async () => {
    ghAnswers = [() => ({ code: 1, stdout: "" })];
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: false,
      text: MC_PR_FAILED,
      transient: true,
    });
    ghAnswers = [list()];
    tools.openDraftPr.mockResolvedValueOnce({ text: MC_PR_FAILED, isError: true });
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toMatchObject({
      ok: false,
      transient: true,
    });
    ghAnswers = [list()];
    tools.openDraftPr.mockResolvedValueOnce({ text: "The PR body mentions @x.", isError: true });
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: false,
      text: "The PR body mentions @x.",
      transient: false,
    });
  });
});

describe("openPr: the branch has moved on, and a PR that cannot be named", () => {
  it("counts a branch that moved past the push as nothing yet, not as a refusal", async () => {
    ghAnswers = [list()];
    tools.openDraftPr.mockResolvedValueOnce({ text: MC_PUSH_FIRST, isError: true });
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: true,
      prNumber: null,
      tipMoved: true,
    });
  });

  it("names a PR whose URL it was not given from the open PRs opened since the run began", async () => {
    ghAnswers = [
      list(),
      list(
        { number: 5, createdAt: "2026-10-20T09:00:00Z" },
        { number: 31, createdAt: "2026-10-21T10:30:00Z" },
      ),
    ];
    tools.openDraftPr.mockResolvedValueOnce({ text: "A PR is already open: (no URL given)" });
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: true,
      prNumber: 31,
    });
    expect(ghCalls[1]).toEqual([
      "pr",
      "list",
      "--repo=o/mc",
      `--head=${BRANCH}`,
      "--state=open",
      "--json=number,createdAt",
    ]);
  });

  it("does not name an earlier run's PR", async () => {
    ghAnswers = [list(), list({ number: 5, createdAt: "2026-10-20T09:00:00Z" })];
    tools.openDraftPr.mockResolvedValueOnce({ text: "A PR is already open: (no URL given)" });
    expect(await createPublisher(deps()).openPr(run(), TICKET, "n")).toEqual({
      ok: true,
      prNumber: null,
    });
  });
});

describe("cleanLog", () => {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);

  const c1 = String.fromCharCode;

  it("strips C1 controls", () => {
    expect(cleanLog(`a${c1(0x80)}b${c1(0x85)}c${c1(0x8a)}d`)).toBe("abcd");
  });

  it("strips CSI sequences whatever their parameter bytes: colon-separated, private, 8-bit", () => {
    expect(cleanLog(`${esc}[38:5:196mred${esc}[0m`)).toBe("red");
    expect(cleanLog(`${esc}[>0cx${esc}[?25lx${esc}[1;2 qx`)).toBe("xxx");
    expect(cleanLog(`${c1(0x9b)}31mred${c1(0x9b)}0m`)).toBe("red");
  });

  it("strips single-character escapes: Fp, Fe and Fs", () => {
    expect(cleanLog(`a${esc}=b${esc}7c${esc}Md${esc}De${esc}cf`)).toBe("abcdef");
  });

  it("strips device-control, start-of-string, privacy and application strings whole", () => {
    expect(cleanLog(`a${esc}P1$r0m${esc}\\b`)).toBe("ab");
    expect(cleanLog(`a${esc}Xsos payload\nmore${esc}\\b`)).toBe("ab");
    expect(cleanLog(`a${esc}^pm payload${esc}\\b`)).toBe("ab");
    expect(cleanLog(`a${esc}_apc payload${esc}\\b`)).toBe("ab");
    expect(cleanLog(`a${c1(0x90)}8-bit dcs${c1(0x9c)}b${c1(0x9d)}0;title${c1(0x9c)}c`)).toBe("abc");
  });

  it("strips operating-system commands whole, ST- and BEL-terminated", () => {
    const link = `${esc}]8;;https://example.com/x${esc}\\text${esc}]8;;${esc}\\`;
    expect(cleanLog(link)).toBe("text");
    expect(cleanLog(`${esc}]0;window title${bel}after`)).toBe("after");
  });

  it("strips charset sequences", () => {
    expect(cleanLog(`${esc}(Bplain${esc})0${esc}#8${esc}%G`)).toBe("plain");
  });

  it("keeps newlines, tabs and ordinary text", () => {
    expect(cleanLog("a\tb\nc é 日本")).toBe("a\tb\nc é 日本");
  });
});

describe("rerunFailed", () => {
  const listed =
    (...r: { databaseId: number; name: string; conclusion: string }[]) =>
    () => ({
      code: 0,
      stdout: JSON.stringify(r.map((x) => ({ status: "completed", ...x }))),
    });

  it("re-runs the failed jobs of each failed run, argv only", async () => {
    ghAnswers = [
      listed(
        { databaseId: 11, name: "test", conclusion: "failure" },
        { databaseId: 12, name: "lint", conclusion: "success" },
      ),
      () => ({ code: 0, stdout: "" }),
    ];
    const out = await createPublisher(deps()).rerunFailed("o/mc", SHA);
    expect(out).toEqual([{ id: 11, name: "test" }]);
    expect(ghCalls[1]).toEqual(["run", "rerun", "--repo=o/mc", "11", "--failed"]);
    expect(ghCalls).toHaveLength(2);
  });

  it("re-runs a run whose jobs were cancelled or timed out, like a failed one", async () => {
    ghAnswers = [
      listed(
        { databaseId: 11, name: "server", conclusion: "cancelled" },
        { databaseId: 12, name: "web", conclusion: "timed_out" },
        { databaseId: 13, name: "lint", conclusion: "success" },
      ),
      () => ({ code: 0, stdout: "" }),
      () => ({ code: 0, stdout: "" }),
    ];
    const out = await createPublisher(deps()).rerunFailed("o/mc", SHA);
    expect(out).toEqual([
      { id: 11, name: "server" },
      { id: 12, name: "web" },
    ]);
  });

  it("re-runs nothing when no run failed, was cancelled or timed out", async () => {
    ghAnswers = [listed({ databaseId: 13, name: "lint", conclusion: "success" })];
    expect(await createPublisher(deps()).rerunFailed("o/mc", SHA)).toEqual([]);
    expect(ghCalls).toHaveLength(1);
  });

  it("answers running, and re-runs nothing, while a listed run has not completed", async () => {
    ghAnswers = [
      () => ({
        code: 0,
        stdout: JSON.stringify([
          { databaseId: 11, name: "test", conclusion: "failure", status: "completed" },
          { databaseId: 12, name: "lint", conclusion: "", status: "in_progress" },
        ]),
      }),
    ];
    expect(await createPublisher(deps()).rerunFailed("o/mc", SHA)).toBe("running");
    expect(ghCalls).toHaveLength(1);
  });

  it("answers null when gh refuses and nothing was re-run, or the sha is not a commit", async () => {
    ghAnswers = [
      listed({ databaseId: 11, name: "test", conclusion: "failure" }),
      () => ({ code: 1, stdout: "" }),
    ];
    expect(await createPublisher(deps()).rerunFailed("o/mc", SHA)).toBeNull();
    expect(await createPublisher(deps()).rerunFailed("o/mc", "--bad")).toBeNull();
  });
});

describe("ciExcerpt", () => {
  const runs =
    (...r: { databaseId: number; name: string; conclusion: string }[]) =>
    () => ({
      code: 0,
      stdout: JSON.stringify(r),
    });

  it("reads the last lines of each failed run's log, cleaned and prefixed with the run's name", async () => {
    const log = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`;
    ghAnswers = [
      runs(
        { databaseId: 11, name: "test", conclusion: "failure" },
        { databaseId: 12, name: "lint", conclusion: "success" },
      ),
      () => ({ code: 0, stdout: log }),
    ];
    const out = await createPublisher(deps()).ciExcerpt("o/mc", SHA);
    const lines = out.split("\n");
    expect(lines[0]).toBe("test:");
    expect(lines).toHaveLength(1 + CI_EXCERPT_LINES);
    expect(lines.at(-1)).toBe("line 199");
    expect(lines[1]).toBe(`line ${200 - CI_EXCERPT_LINES}`);
    expect(ghCalls[0]).toEqual([
      "run",
      "list",
      "--repo=o/mc",
      `--commit=${SHA}`,
      "--json=databaseId,name,conclusion",
    ]);
    expect(ghCalls[1]).toEqual(["run", "view", "--repo=o/mc", "11", "--log-failed"]);
  });

  it("strips colour codes and control characters, and caps the size", async () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    expect(cleanLog(`${esc}[31mred${esc}[0m${bell}\r\nok\ttab`)).toBe("red\nok\ttab");
    const big = `${"x".repeat(100)}\n`.repeat(200);
    ghAnswers = [
      runs({ databaseId: 11, name: "test", conclusion: "failure" }),
      () => ({ code: 0, stdout: big }),
    ];
    const out = await createPublisher(deps()).ciExcerpt("o/mc", SHA);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CI_EXCERPT_MAX);
    expect(out.startsWith("test:\n")).toBe(true);
  });

  it("counts bytes, headers and separators against the cap, and skips a header with no room", async () => {
    const wide = `${"日本語".repeat(40)}\n`.repeat(80);
    ghAnswers = [
      runs(
        { databaseId: 1, name: "test", conclusion: "failure" },
        { databaseId: 2, name: "lint", conclusion: "failure" },
        { databaseId: 3, name: "build", conclusion: "failure" },
      ),
      () => ({ code: 0, stdout: wide }),
      () => ({ code: 0, stdout: wide }),
      () => ({ code: 0, stdout: wide }),
    ];
    const out = await createPublisher(deps()).ciExcerpt("o/mc", SHA);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CI_EXCERPT_MAX);
    // the first run takes nearly everything; no later header stands with nothing under it
    for (const section of out.split("\n\n")) {
      expect(section).toMatch(/^[a-z]+:\n\S/);
    }
    // the first run's text takes the whole budget: the second run gets no header, and its log is
    // not read at all
    ghCalls = [];
    ghAnswers = [
      runs(
        { databaseId: 1, name: "test", conclusion: "failure" },
        { databaseId: 2, name: "x".repeat(CI_EXCERPT_MAX), conclusion: "failure" },
      ),
      () => ({ code: 0, stdout: "y".repeat(CI_EXCERPT_MAX * 2) }),
    ];
    const full = await createPublisher(deps()).ciExcerpt("o/mc", SHA);
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(CI_EXCERPT_MAX);
    expect(ghCalls.filter((c) => c[1] === "view")).toHaveLength(1);
  });

  it("fills the budget exactly across sections when the first does not use it all", async () => {
    // 80 lines of 200 bytes for the second run; the first run's 20 bytes come off the budget
    const long = `${"z".repeat(199)}\n`.repeat(80);
    ghAnswers = [
      runs(
        { databaseId: 1, name: "a", conclusion: "failure" },
        { databaseId: 2, name: "b", conclusion: "failure" },
      ),
      () => ({ code: 0, stdout: "first run log\n" }),
      () => ({ code: 0, stdout: long }),
    ];
    const out = await createPublisher(deps()).ciExcerpt("o/mc", SHA);
    const [first, second] = out.split("\n\n");
    expect(first).toBe("a:\nfirst run log");
    expect(second?.startsWith("b:\n")).toBe(true);
    expect(Buffer.byteLength(out)).toBe(CI_EXCERPT_MAX);
  });

  it("does not call an empty log a missing run", async () => {
    ghAnswers = [
      runs({ databaseId: 1, name: "a", conclusion: "failure" }),
      () => ({ code: 0, stdout: "\n\n" }),
    ];
    const out = await createPublisher(deps()).ciExcerpt("o/mc", SHA);
    expect(out).toBe(EMPTY_LOG);
    expect(out).not.toBe(NO_FAILED_RUN);
  });

  it("says so when no Actions run failed, and when gh fails", async () => {
    ghAnswers = [runs({ databaseId: 1, name: "t", conclusion: "success" })];
    expect(await createPublisher(deps()).ciExcerpt("o/mc", SHA)).toBe(NO_FAILED_RUN);
    expect(NO_FAILED_RUN).toBe("(no failed Actions run to read)");
    ghAnswers = [() => ({ code: 1, stdout: "" })];
    expect(await createPublisher(deps()).ciExcerpt("o/mc", SHA)).toBe(CI_LOG_UNREADABLE);
    ghAnswers = [() => ({ code: 0, stdout: "not json" })];
    expect(await createPublisher(deps()).ciExcerpt("o/mc", SHA)).toBe(CI_LOG_UNREADABLE);
    ghAnswers = [
      runs({ databaseId: 1, name: "t", conclusion: "failure" }),
      () => ({ code: 1, stdout: "" }),
    ];
    expect(await createPublisher(deps()).ciExcerpt("o/mc", SHA)).toBe(CI_LOG_UNREADABLE);
    expect(CI_LOG_UNREADABLE).toBe("(the CI log could not be read)");
  });

  it("asks for a 16 MiB log buffer", async () => {
    const seen: (number | undefined)[] = [];
    const spy: GhRunner = async (args, opts) => {
      seen.push(opts.maxBuffer);
      return args[1] === "list"
        ? {
            code: 0,
            stdout: JSON.stringify([{ databaseId: 1, name: "t", conclusion: "failure" }]),
            stderr: "",
          }
        : { code: 0, stdout: "x", stderr: "" };
    };
    await createPublisher(deps({ gh: spy })).ciExcerpt("o/mc", SHA);
    expect(seen).toEqual([undefined, 16 * 1024 * 1024]);
  });
});

describe("rerunRuling and rerunState", () => {
  type R = { databaseId: number; conclusion: string; attempt: number; status?: string };
  const runs =
    (...r: R[]) =>
    () => ({ code: 0, stdout: JSON.stringify(r) });

  it("re-runs only the failed runs, and returns each one's attempt from before", async () => {
    ghAnswers = [
      runs(
        { databaseId: 11, conclusion: "failure", attempt: 1 },
        { databaseId: 12, conclusion: "success", attempt: 1 },
        { databaseId: 13, conclusion: "timed_out", attempt: 2 },
      ),
      () => ({ code: 0, stdout: "" }),
      () => ({ code: 0, stdout: "" }),
    ];
    const r = await createPublisher(deps()).rerunRuling("o/mc", SHA);
    expect(r).toEqual({
      ok: true,
      runs: [
        { id: 11, attempt: 1 },
        { id: 13, attempt: 2 },
      ],
    });
    expect(ghCalls[0]).toEqual([
      "run",
      "list",
      "--repo=o/mc",
      `--commit=${SHA}`,
      "--json=databaseId,conclusion,attempt",
    ]);
    expect(ghCalls.slice(1)).toEqual([
      ["run", "rerun", "--repo=o/mc", "11", "--failed"],
      ["run", "rerun", "--repo=o/mc", "13", "--failed"],
    ]);
  });

  it("re-runs a cancelled run, and reads an un-re-run cancelled run as still failed", async () => {
    ghAnswers = [
      runs({ databaseId: 11, conclusion: "cancelled", attempt: 1 }),
      () => ({ code: 0, stdout: "" }),
    ];
    expect(await createPublisher(deps()).rerunRuling("o/mc", SHA)).toEqual({
      ok: true,
      runs: [{ id: 11, attempt: 1 }],
    });
    expect(ghCalls[1]).toEqual(["run", "rerun", "--repo=o/mc", "11", "--failed"]);
    ghAnswers = [
      runs(
        { databaseId: 11, conclusion: "success", attempt: 2, status: "completed" },
        { databaseId: 13, conclusion: "cancelled", attempt: 1, status: "completed" },
      ),
    ];
    expect(await createPublisher(deps()).rerunState("o/mc", SHA, [{ id: 11, attempt: 1 }])).toEqual(
      { ok: true, outcome: "failed" },
    );
  });

  it("returns the runs already re-run when a later rerun fails, so the caller records them", async () => {
    ghAnswers = [
      runs(
        { databaseId: 11, conclusion: "failure", attempt: 1 },
        { databaseId: 13, conclusion: "failure", attempt: 1 },
      ),
      () => ({ code: 0, stdout: "" }),
      () => ({ code: 1, stdout: "", stderr: "boom" }),
    ];
    expect(await createPublisher(deps()).rerunRuling("o/mc", SHA)).toEqual({
      ok: true,
      runs: [{ id: 11, attempt: 1 }],
    });
    // a first rerun that fails is still a refusal
    ghAnswers = [
      runs({ databaseId: 11, conclusion: "failure", attempt: 1 }),
      () => ({ code: 1, stdout: "", stderr: "boom" }),
    ];
    expect(await createPublisher(deps()).rerunRuling("o/mc", SHA)).toMatchObject({ ok: false });
  });

  it("is failed when a failed run was not re-run, though the re-run runs passed", async () => {
    ghAnswers = [
      runs(
        { databaseId: 11, conclusion: "success", attempt: 2, status: "completed" },
        { databaseId: 13, conclusion: "failure", attempt: 1, status: "completed" },
      ),
    ];
    expect(await createPublisher(deps()).rerunState("o/mc", SHA, [{ id: 11, attempt: 1 }])).toEqual(
      { ok: true, outcome: "failed" },
    );
  });

  it("refuses when no run failed, and when gh cannot list", async () => {
    ghAnswers = [runs({ databaseId: 12, conclusion: "success", attempt: 1 })];
    expect(await createPublisher(deps()).rerunRuling("o/mc", SHA)).toMatchObject({
      ok: false,
      text: NO_FAILED_RUN,
    });
    ghAnswers = [() => ({ code: 1, stdout: "", stderr: "boom" })];
    expect(await createPublisher(deps()).rerunRuling("o/mc", SHA)).toMatchObject({
      ok: false,
      transient: true,
    });
    expect(ghCalls).toHaveLength(2);
  });

  it("keeps a 1000-character CI refusal whole", async () => {
    const stderr = "x".repeat(1000);
    ghAnswers = [() => ({ code: 1, stdout: "", stderr })];
    expect(await createPublisher(deps()).rerunRuling("o/mc", SHA)).toEqual({
      ok: false,
      text: `gh run list failed: ${stderr}`,
      transient: true,
    });
  });

  it("reads a re-run as pending until its attempt is higher and it is completed", async () => {
    const saved = [{ id: 11, attempt: 1 }];
    const state = async (...r: R[]) => {
      ghAnswers = [runs(...r)];
      return createPublisher(deps()).rerunState("o/mc", SHA, saved);
    };
    expect(
      await state({ databaseId: 11, conclusion: "failure", attempt: 1, status: "completed" }),
    ).toEqual({
      ok: true,
      outcome: "pending",
    });
    expect(
      await state({ databaseId: 11, conclusion: "", attempt: 2, status: "in_progress" }),
    ).toEqual({
      ok: true,
      outcome: "pending",
    });
    expect(
      await state({ databaseId: 11, conclusion: "success", attempt: 2, status: "completed" }),
    ).toEqual({
      ok: true,
      outcome: "passed",
    });
    expect(
      await state({ databaseId: 11, conclusion: "failure", attempt: 2, status: "completed" }),
    ).toEqual({
      ok: true,
      outcome: "failed",
    });
    expect(ghCalls[0]).toEqual([
      "run",
      "list",
      "--repo=o/mc",
      `--commit=${SHA}`,
      "--json=databaseId,status,conclusion,attempt",
    ]);
  });

  it("is failed if any run failed, and a run that cannot be found is a transient refusal", async () => {
    const saved = [
      { id: 11, attempt: 1 },
      { id: 13, attempt: 1 },
    ];
    ghAnswers = [
      runs(
        { databaseId: 11, conclusion: "skipped", attempt: 2, status: "completed" },
        { databaseId: 13, conclusion: "cancelled", attempt: 2, status: "completed" },
      ),
    ];
    expect(await createPublisher(deps()).rerunState("o/mc", SHA, saved)).toEqual({
      ok: true,
      outcome: "failed",
    });
    ghAnswers = [runs({ databaseId: 11, conclusion: "success", attempt: 2, status: "completed" })];
    expect(await createPublisher(deps()).rerunState("o/mc", SHA, saved)).toMatchObject({
      ok: false,
      transient: true,
    });
  });
});

describe("gh maxBuffer", () => {
  const emit = ["-e", "process.stdout.write('x'.repeat(2_000_000))"];

  it("keeps the 1 MiB default and takes a larger one", async () => {
    const g = createGh(process.execPath);
    expect((await g(emit, { cwd: dir })).code).toBeNull();
    const big = await g(emit, { cwd: dir, maxBuffer: 4 * 1024 * 1024 });
    expect(big.code).toBe(0);
    expect(big.stdout).toHaveLength(2_000_000);
  });
});

describe("reviewPr", () => {
  it("reads authoritative immutable PR inputs independently of SQLite", async () => {
    ghAnswers.push(() => ({
      code: 0,
      stdout: JSON.stringify({
        state: "MERGED",
        headRefOid: SHA,
        baseRefOid: BASE,
        mergeCommit: { oid: BASE },
      }),
    }));
    expect(await createPublisher(deps()).reviewPr(run(), 12)).toEqual({
      state: "merged",
      headSha: SHA,
      baseSha: BASE,
      mergeCommitSha: BASE,
    });
    expect(ghCalls[0]).toContain("state,headRefOid,baseRefOid,mergeCommit");
  });
});

describe("hardRuleTouches", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "clone", ".git"), { recursive: true });
  });

  it("reads NUL-delimited away diff statuses, keeping deletions from renames", async () => {
    const calls: string[][] = [];
    const git = (async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "merge-base"
        ? `${BASE}\n`
        : "D\0src/old.test.ts\0A\0src/new.test.ts\0M\0docs/with space.md\0";
    }) as never;
    expect(await createPublisher(deps({ git })).awayDiff(run(), SHA)).toEqual({
      base: BASE,
      changes: [
        { status: "D", path: "src/old.test.ts" },
        { status: "A", path: "src/new.test.ts" },
        { status: "M", path: "docs/with space.md" },
      ],
    });
    expect(calls[1]).toEqual(["diff", "--name-status", "-z", "--no-renames", BASE, SHA, "--"]);
  });

  it("an unreadable diff never establishes away safety", async () => {
    const git = (async () => {
      throw new Error("unreadable");
    }) as never;
    expect(await createPublisher(deps({ git })).awayDiff(run(), SHA)).toBeNull();
    expect(await createPublisher(deps({ git })).awayDiff(run(), "--bad-sha")).toBeNull();
  });

  it("lists the paths between origin's default branch and the sha that match a hard rule", async () => {
    const calls: string[][] = [];
    const git = (async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "merge-base"
        ? `${BASE}\n`
        : ".github/workflows/ci.yml\0apps/web/a.ts\0CLAUDE.md\0loops/x/y.sh\0";
    }) as never;
    const paths = await createPublisher(deps({ git })).hardRuleTouches(run(), SHA, [
      ".github/**",
      "CLAUDE.md",
      "loops/**",
    ]);
    expect(paths).toEqual([".github/workflows/ci.yml", "CLAUDE.md", "loops/x/y.sh"]);
    expect(calls).toEqual([
      ["rev-parse", "-q", "--verify", `${SHA}^{commit}`],
      ["merge-base", "refs/remotes/origin/HEAD", SHA],
      ["diff", "--name-only", "-z", "--no-renames", BASE, SHA, "--"],
    ]);
  });

  it("reconstructs a merged head diff from the immutable merge first parent", async () => {
    const calls: string[][] = [];
    const git = (async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "merge-base" ? BASE : "CLAUDE.md\0";
    }) as never;
    const publisher = createPublisher(deps({ git }));
    expect(await publisher.hardRuleTouches(run(), SHA, ["CLAUDE.md"], BASE)).toEqual(["CLAUDE.md"]);
    expect(calls).toEqual([
      ["rev-parse", "-q", "--verify", `${SHA}^{commit}`],
      ["rev-parse", "-q", "--verify", `${BASE}^{commit}`],
      ["merge-base", `${BASE}^1`, SHA],
      ["diff", "--name-only", "-z", "--no-renames", BASE, SHA, "--"],
    ]);
  });

  it("uses a persisted immutable base even when origin already contains the head", async () => {
    const calls: string[][] = [];
    const git = (async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "merge-base" ? BASE : "CLAUDE.md\0";
    }) as never;
    expect(
      await createPublisher(deps({ git })).hardRuleTouches(
        run(),
        SHA,
        ["CLAUDE.md"],
        undefined,
        BASE,
      ),
    ).toEqual(["CLAUDE.md"]);
    expect(calls).toEqual([
      ["rev-parse", "-q", "--verify", `${SHA}^{commit}`],
      ["rev-parse", "-q", "--verify", `${BASE}^{commit}`],
      ["merge-base", BASE, SHA],
      ["diff", "--name-only", "-z", "--no-renames", BASE, SHA, "--"],
    ]);
  });

  it.each(["base", "head", "merge"])(
    "fetches a missing immutable %s in the diff clone",
    async (missing) => {
      const available = new Set(
        [SHA, BASE].filter((sha) => sha !== (missing === "head" ? SHA : BASE)),
      );
      const calls: string[][] = [];
      const git = (async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "rev-parse") {
          if (!available.has(args[3].replace("^{commit}", "")))
            throw Object.assign(new Error("missing"), { code: 1 });
          return SHA;
        }
        if (args[0] === "fetch") {
          available.add(args[3]);
          return "";
        }
        if (args[0] === "merge-base") {
          if (!available.has(SHA) || !available.has(BASE)) throw new Error("missing diff input");
          return BASE;
        }
        return "CLAUDE.md\0";
      }) as never;
      expect(
        await createPublisher(deps({ git })).hardRuleTouches(
          run(),
          SHA,
          ["CLAUDE.md"],
          missing === "merge" ? BASE : undefined,
          BASE,
        ),
      ).toEqual(["CLAUDE.md"]);
      expect(calls).toContainEqual([
        "fetch",
        "--no-tags",
        "origin",
        missing === "head" ? SHA : BASE,
      ]);
    },
  );

  it("reads nothing for a sha that is not a sha, or with no rules", async () => {
    const git = (async () => {
      throw new Error("git was not expected");
    }) as never;
    const p = createPublisher(deps({ git }));
    expect(await p.hardRuleTouches(run(), "--upload-pack=x", ["a/**"])).toEqual([]);
    expect(await p.hardRuleTouches(run(), SHA, [])).toEqual([]);
  });
});

describe("a moved file keeps its old path (real git)", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  let clone: string;
  let sha: string;

  beforeEach(() => {
    const origin = join(dir, "origin.git");
    clone = join(dir, "clone");
    mkdirSync(clone, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(clone, "init", "-q", "-b", "main");
    git(clone, "config", "user.name", "t");
    git(clone, "config", "user.email", "t@example.com");
    // a user gitconfig that turns rename detection on
    git(clone, "config", "diff.renames", "true");
    git(clone, "remote", "add", "origin", origin);
    mkdirSync(join(clone, "apps/server/src/engine"), { recursive: true });
    mkdirSync(join(clone, "apps/web"), { recursive: true });
    const body = (n: string) => `${n}\n`.repeat(40);
    writeFileSync(join(clone, "CLAUDE.md"), body("rules"));
    writeFileSync(join(clone, "apps/server/src/engine/x.ts"), body("engine"));
    writeFileSync(join(clone, "apps/web/a.ts"), body("web"));
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "base");
    git(clone, "push", "-q", "origin", "main");
    git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(clone, "checkout", "-q", "-b", BRANCH);
  });

  const commitHead = (): string => {
    git(clone, "commit", "-q", "-m", "move");
    return git(clone, "rev-parse", "HEAD");
  };

  it("hardRuleTouches reports a hard-rule file moved to a path no rule covers", async () => {
    mkdirSync(join(clone, "docs"));
    git(clone, "mv", "CLAUDE.md", "docs/moved.md");
    git(clone, "mv", "apps/server/src/engine/x.ts", "docs/x.ts");
    sha = commitHead();
    const paths = await createPublisher(deps()).hardRuleTouches(run(), sha, [
      "CLAUDE.md",
      "apps/server/src/engine/**",
    ]);
    expect(paths.sort()).toEqual(["CLAUDE.md", "apps/server/src/engine/x.ts"]);
  });

  it("gateFacts reports the old path of a file moved into the seat's area as a stray", async () => {
    git(clone, "mv", "apps/web/a.ts", "apps/server/a.ts");
    sha = commitHead();
    git(clone, "push", "-q", "origin", BRANCH);
    const c = config();
    const seat = c.crew?.sessions[0]?.seats[0];
    if (seat !== undefined) seat.area = ["apps/server/**"];
    store.upsertRun(run());
    const g = await createPublisher(deps({ config: c })).gateFacts(run(), sha);
    expect(g).toMatchObject({ ok: true });
    expect(g.ok ? g.facts.strays : []).toEqual(["apps/web/a.ts"]);
  });
});

describe("postMinorFindings", () => {
  const VIEW_OK = JSON.stringify({ headRefName: BRANCH, state: "OPEN" });
  const R = run({ loop: { prNumber: 12 } as never });
  let posted: string | null;

  const minor = (summary: string, line = 3) => ({
    severity: "Minor" as const,
    file: "a.ts",
    line,
    summary,
    scenario: "w",
    fix: "f",
  });
  /** Records a review of the run with `findings`; returns what postMinorFindings takes. */
  const review = (findings: ReturnType<typeof minor>[]) => {
    const id = store.requestReview({
      authorRunId: R.id,
      repoId: "mc",
      seatId: "retro",
      prNumber: 12,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: START,
    });
    if (id === null) throw new Error("no review");
    store.setReviewState(id, ["queued"], "running", { at: START, runId: "rr" });
    store.recordFindings(id, "rr", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "ok",
      findings,
      at: START,
    });
    return { id, sha: SHA, retro: "RETRO" };
  };
  const answer = (view = VIEW_OK, editCode = 0) => {
    posted = null;
    ghAnswers = [
      () => ({ code: 0, stdout: view }),
      (args) => {
        const file = args.find((a) => a.startsWith("--body-file="))?.slice("--body-file=".length);
        if (file !== undefined) posted = readFileSync(file, "utf8");
        return { code: editCode, stdout: "" };
      },
    ];
  };
  const bodyFiles = () => {
    const crew = join(dir, "crew");
    return existsSync(crew) ? readdirSync(crew).filter((f) => f.startsWith("pr-")) : [];
  };

  beforeEach(() => {
    store.upsertRun(R);
    store.addEvidence(R.id, "Changed it.", START);
  });

  it("rewrites the body with the minors, before the closing line", async () => {
    const rv = review([minor("first"), minor("second", 0)]);
    answer();
    const r = await createPublisher(deps()).postMinorFindings(R, rv);
    expect(r).toEqual({ ok: true });
    expect(ghCalls.map((c) => c.slice(0, 3))).toEqual([
      ["pr", "view", "12"],
      ["pr", "edit", "12"],
    ]);
    const at = (s: string) => (posted ?? "").indexOf(s);
    expect(at(MINOR_HEADING)).toBeGreaterThan(-1);
    expect(at(MINOR_HEADING)).toBeLessThan(at(minorIntro("RETRO", SHA)));
    expect(at(minorIntro("RETRO", SHA))).toBeLessThan(at("- `a.ts:3` — first"));
    expect(at("- `a.ts:3` — first")).toBeLessThan(at("- `a.ts` — second"));
    expect(at("- `a.ts` — second")).toBeLessThan(at("Closes #7."));
    expect(posted?.endsWith("Opened by GUIDO-1 (Mission Control).\n")).toBe(true);
  });

  it("withholds a line that would notify someone", async () => {
    const rv = review([minor("ping @octocat")]);
    answer();
    await createPublisher(deps()).postMinorFindings(R, rv);
    expect(posted).toContain(MINOR_WITHHELD);
    expect(posted).not.toContain("@octocat");
  });

  it("lists 20 and counts the rest", async () => {
    const rv = review(Array.from({ length: 21 }, (_, k) => minor(`m${k}`)));
    answer();
    await createPublisher(deps()).postMinorFindings(R, rv);
    const lines = (posted ?? "").split("\n");
    expect(lines.filter((l) => l.startsWith("- `a.ts:3`"))).toHaveLength(20);
    expect(lines).toContain(minorMoreLine(1));
  });

  it("drops the section when there are no minors", async () => {
    const rv = review([]);
    answer();
    await createPublisher(deps()).postMinorFindings(R, rv);
    expect(posted).not.toContain(MINOR_HEADING);
    expect(posted).toContain("Closes #7.");
  });

  it("edits nothing that is not the run's open PR", async () => {
    const rv = review([minor("s")]);
    for (const view of [
      JSON.stringify({ headRefName: "other", state: "OPEN" }),
      JSON.stringify({ headRefName: BRANCH, state: "CLOSED" }),
    ]) {
      ghCalls = [];
      answer(view);
      const r = await createPublisher(deps()).postMinorFindings(R, rv);
      expect(r).toMatchObject({ ok: false, transient: false });
      expect(ghCalls.some((c) => c[1] === "edit")).toBe(false);
    }
  });

  it("is transient when gh fails, and leaves no body file", async () => {
    const rv = review([minor("s")]);
    answer(VIEW_OK, 1);
    const r = await createPublisher(deps()).postMinorFindings(R, rv);
    expect(r).toMatchObject({ ok: false, transient: true, text: MC_PR_EDIT_FAILED });
    expect(bodyFiles()).toEqual([]);
  });

  it("refuses a body with a secret, with one guard hit and no gh call", async () => {
    const r = await editRunPrBody(deps(), R.id, 12, `ghp_${"a".repeat(36)}`);
    expect(r).toEqual({ text: MC_PR_BODY_REFUSED, isError: true });
    expect(ghCalls).toEqual([]);
    expect(store.guardHits(0)).toHaveLength(1);
  });

  it("an unended run its seat no longer holds is still edited", async () => {
    answer();
    const r = await editRunPrBody(deps(), R.id, 12, "Hello.");
    expect(r).toEqual({ text: prEditedText(12) });
  });
});

describe("setEvidenceSection", () => {
  const R = run({ loop: { prNumber: 12 } as never });
  const VIEW_OK = JSON.stringify({ headRefName: BRANCH, state: "OPEN" });
  const BODY =
    "#7 — Fix\n\n## What changed\n\nDid it.\n\nCloses #7.\n\nOpened by GUIDO-1 (Mission Control).\n";
  let posted: string | null;

  /** gh answers: the body read, the open-PR check, then the edit. */
  const answer = (body: string, editCode = 0) => {
    posted = null;
    ghAnswers = [
      () => ({ code: 0, stdout: JSON.stringify({ body }) }),
      () => ({ code: 0, stdout: VIEW_OK }),
      (args) => {
        const file = args.find((a) => a.startsWith("--body-file="))?.slice("--body-file=".length);
        if (file !== undefined) posted = readFileSync(file, "utf8");
        return { code: editCode, stdout: "" };
      },
    ];
  };

  beforeEach(() => {
    store.upsertRun(R);
  });

  it("puts the section before the Closes line, keeping the rest and one Opened-by line", async () => {
    answer(BODY);
    const r = await createPublisher(deps()).setEvidenceSection(R, `${EVIDENCE_HEADING}\n\nlines`);
    expect(r).toEqual({ ok: true });
    expect(posted).toBe(
      `#7 — Fix\n\n## What changed\n\nDid it.\n\n${EVIDENCE_HEADING}\n\nlines\n\nCloses #7.\n\nOpened by GUIDO-1 (Mission Control).\n`,
    );
  });

  it("replaces an earlier section instead of adding a second", async () => {
    const withOld = BODY.replace("Closes #7.", `${EVIDENCE_HEADING}\n\nold\n\nCloses #7.`);
    answer(withOld);
    await createPublisher(deps()).setEvidenceSection(R, `${EVIDENCE_HEADING}\n\nnew`);
    expect(posted).toContain("new");
    expect(posted).not.toContain("old");
    expect((posted ?? "").split(EVIDENCE_HEADING)).toHaveLength(2);
  });

  it("edits nothing when the body already holds the section", async () => {
    const section = `${EVIDENCE_HEADING}\n\nsame`;
    answer(BODY.replace("Closes #7.", `${section}\n\nCloses #7.`));
    const r = await createPublisher(deps()).setEvidenceSection(R, section);
    expect(r).toEqual({ ok: true });
    expect(ghCalls.some((c) => c[1] === "edit")).toBe(false);
  });

  it("is transient when the PR cannot be read", async () => {
    ghAnswers = [() => ({ code: 1, stdout: "", stderr: "net" })];
    const r = await createPublisher(deps()).setEvidenceSection(R, `${EVIDENCE_HEADING}\n\nx`);
    expect(r).toMatchObject({ ok: false, transient: true });
  });

  it("is kept by the Minor-findings rewrite", async () => {
    const rv = (() => {
      const id = store.requestReview({
        authorRunId: R.id,
        repoId: "mc",
        seatId: "retro",
        prNumber: 12,
        sha: SHA,
        epoch: 0,
        attempt: 1,
        round: 1,
        at: START,
      });
      if (id === null) throw new Error("no review");
      store.setReviewState(id, ["queued"], "running", { at: START, runId: "rr" });
      store.recordFindings(id, "rr", {
        verdict: { spec: "pass", quality: "pass" },
        summary: "ok",
        findings: [
          { severity: "Minor", file: "a.ts", line: 3, summary: "first", scenario: "w", fix: "f" },
        ],
        at: START,
      });
      return { id, sha: SHA, retro: "RETRO" };
    })();
    store.addEvidence(R.id, "Changed it.", START);
    let sent: string | null = null;
    ghAnswers = [
      () => ({ code: 0, stdout: VIEW_OK }),
      (args) => {
        const file = args.find((a) => a.startsWith("--body-file="))?.slice("--body-file=".length);
        if (file !== undefined) sent = readFileSync(file, "utf8");
        return { code: 0, stdout: "" };
      },
    ];
    await createPublisher(
      deps({ prEvidenceSection: () => `${EVIDENCE_HEADING}\n\nkept lines` }),
    ).postMinorFindings(R, rv);
    expect(sent).toContain(MINOR_HEADING);
    expect(sent).toContain(`${EVIDENCE_HEADING}\n\nkept lines`);
    expect((sent as unknown as string).indexOf("kept lines")).toBeLessThan(
      (sent as unknown as string).indexOf("Closes #7."),
    );
  });
});

describe("setReviewStatus", () => {
  it("posts the status through gh api", async () => {
    ghAnswers = [() => ({ code: 0, stdout: "{}" })];
    const r = await createPublisher(deps()).setReviewStatus(
      run(),
      SHA,
      "success",
      "QA review passed",
    );
    expect(r).toEqual({ ok: true });
    expect(ghCalls).toEqual([
      [
        "api",
        `repos/o/mc/statuses/${SHA}`,
        "-f",
        "state=success",
        "-f",
        "context=mc/review",
        "-f",
        "description=QA review passed",
      ],
    ]);
  });

  it("a gh failure is transient", async () => {
    ghAnswers = [() => ({ code: 1, stdout: "" })];
    const r = await createPublisher(deps()).setReviewStatus(run(), SHA, "pending", "x");
    expect(r).toEqual({ ok: false, text: REVIEW_STATUS_FAILED, transient: true });
  });

  it("a gh failure carries gh's stderr, cleaned and cut", async () => {
    ghAnswers = [
      () => ({
        code: 1,
        stdout: "",
        stderr: `\u001b[31mHTTP 403: forbidden\u001b[0m\n${"x".repeat(STDERR_TEXT_MAX)}`,
      }),
    ];
    const r = await createPublisher(deps()).setReviewStatus(run(), SHA, "pending", "x");
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.text;
    expect(text.startsWith(`${REVIEW_STATUS_FAILED}: HTTP 403: forbidden\n`)).toBe(true);
    expect(text).not.toContain("\u001b");
    expect(text.length).toBe(REVIEW_STATUS_FAILED.length + 2 + STDERR_TEXT_MAX);
  });

  it("cuts stderr by code points without splitting non-ASCII characters", async () => {
    ghAnswers = [() => ({ code: 1, stdout: "", stderr: "🚀".repeat(STDERR_TEXT_MAX + 1) })];
    const r = await createPublisher(deps()).setReviewStatus(run(), SHA, "pending", "x");
    expect(r).toEqual({
      ok: false,
      text: `${REVIEW_STATUS_FAILED}: ${"🚀".repeat(STDERR_TEXT_MAX)}`,
      transient: true,
    });
  });

  it("no repo or a bad sha: no call", async () => {
    const p = createPublisher(deps());
    const gone = await p.setReviewStatus(run({ repoId: "nope" }), SHA, "pending", "x");
    const bad = await p.setReviewStatus(run(), "--x", "pending", "x");
    const refused = { ok: false, text: REVIEW_STATUS_FAILED, transient: false };
    expect(gone).toEqual(refused);
    expect(bad).toEqual(refused);
    expect(ghCalls).toEqual([]);
  });
});

describe("merge steps", () => {
  const MAIN = "d".repeat(40);
  const OTHER = "e".repeat(40);
  /** The git call that asks whether the clone has main's tip (a gitAnswers key). */
  const HAVE_MAIN = `rev-parse -q --verify ${MAIN}^{commit}`;
  const R = run({ loop: { prNumber: 12 } as never });
  const MERGED_RUN = run({
    loop: { prNumber: 12, merging: { sha: SHA, done: ["merge"] } } as never,
  });
  const FORBIDDEN = ["--admin", "--squash", "--rebase", "--auto", "--delete-branch", "--force"];

  type GitAnswer = string | Error | ((args: string[]) => string);
  let gitCalls: string[][];
  let gitAnswers: Record<string, GitAnswer>;

  const git = (async (_cwd: string, args: string[]) => {
    gitCalls.push(args);
    const answer = gitAnswers[args.join(" ")] ?? gitAnswers[args[0] ?? ""];
    if (answer === undefined) throw new Error(`git ${args.join(" ")} was not expected`);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  }) as never;
  const exit1 = Object.assign(new Error("exit 1"), { code: 1 });
  const lsRemote = (main = MAIN, branch: string | null = null) =>
    `ref: refs/heads/main\tHEAD\n${main}\tHEAD\n${branch === null ? "" : `${branch}\trefs/heads/${BRANCH}\n`}`;
  const publisher = (over: Partial<McToolsDeps> = {}) => createPublisher(deps({ git, ...over }));
  const view =
    (state: string, head = SHA, extra: Record<string, unknown> = {}) =>
    () => ({
      code: 0,
      stdout: JSON.stringify({
        state,
        headRefOid: head,
        baseRefName: "main",
        headRefName: BRANCH,
        isCrossRepository: false,
        ...extra,
      }),
    });
  const ok = () => ({ code: 0, stdout: "" });
  const pushed = (name: string) => gitCalls.some((a) => a[0] === name);

  beforeEach(() => {
    mkdirSync(join(dir, "clone", ".git"), { recursive: true });
    gitCalls = [];
    gitAnswers = {};
    store.upsertRun(R);
  });

  describe("gateFacts", () => {
    const withArea = () => {
      const c = config();
      const seat = c.crew?.sessions[0]?.seats[0];
      if (seat !== undefined) seat.area = ["src/**"];
      return publisher({ config: c });
    };
    const ANCESTOR = `merge-base --is-ancestor ${MAIN} ${SHA}`;

    it.each([false, true])(
      "checks the Mission Control block itself (changed: %s)",
      async (changed) => {
        const rules = "## Mission Control\n```yaml\nmc:\n  hard_rules: []\n```\n";
        gitAnswers = {
          "ls-remote": lsRemote(),
          [HAVE_MAIN]: "",
          [ANCESTOR]: "",
          "merge-base": BASE,
          "rev-list": "",
          "cat-file": "",
          diff: "CLAUDE.md\0",
          [`show ${BASE}:CLAUDE.md`]: `# Before\n${rules}`,
          [`show ${SHA}:CLAUDE.md`]: `# After\n${changed ? rules.replace("[]", "[src/**]") : rules}`,
        };
        expect(await withArea().gateFacts(R, SHA)).toMatchObject({
          ok: true,
          facts: { missionControlChanged: changed },
        });
      },
    );

    it.each([
      ["before fence", "## Mission Control\nChanged prose\n```yaml\nmc: {}\n```\n", true],
      ["after fence", "## Mission Control\n```yaml\nmc: {}\n```\nChanged prose\n", true],
      [
        "next heading",
        "## Mission Control\n```yaml\nmc: {}\n```\n## Other\nChanged prose\n",
        false,
      ],
    ])("compares the whole section: %s", async (_name, after, changed) => {
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": BASE,
        "rev-list": "",
        "cat-file": "",
        diff: "CLAUDE.md\0",
        [`show ${BASE}:CLAUDE.md`]: "## Mission Control\n```yaml\nmc: {}\n```\n",
        [`show ${SHA}:CLAUDE.md`]: after,
      };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({
        ok: true,
        facts: { missionControlChanged: changed },
      });
    });

    it.each([
      ["added prose", null, "# Repo\nJust prose\n", false],
      ["added block", null, "## Mission Control\n```yaml\nmc: {}\n```\n", true],
      ["deleted prose", "# Repo\nJust prose\n", null, false],
    ])("checks CLAUDE.md %s", async (_name, before, after, changed) => {
      const absent = Object.assign(new Error("path absent"), {
        code: 128,
        stderr: "fatal: path 'CLAUDE.md' does not exist in commit",
      });
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": BASE,
        "rev-list": "",
        diff: "CLAUDE.md\0",
        [`cat-file -e ${BASE}:CLAUDE.md`]: before === null ? absent : "",
        [`cat-file -e ${SHA}:CLAUDE.md`]: after === null ? absent : "",
        [`show ${BASE}:CLAUDE.md`]: before ?? new Error("must not read absent file"),
        [`show ${SHA}:CLAUDE.md`]: after ?? new Error("must not read absent file"),
      };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({
        ok: true,
        facts: { missionControlChanged: changed },
      });
      if (before === null) expect(gitCalls).not.toContainEqual(["show", `${BASE}:CLAUDE.md`]);
      if (after === null) expect(gitCalls).not.toContainEqual(["show", `${SHA}:CLAUDE.md`]);
    });

    it.each(["cat-file", "show"])("holds on other %s read errors", async (command) => {
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": BASE,
        "rev-list": "",
        diff: "CLAUDE.md\0",
        "cat-file": "",
        show: "# Just prose",
        [command]: Object.assign(new Error("object read failed"), { code: 128 }),
      };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({
        ok: true,
        facts: { missionControlChanged: true },
      });
    });

    it("reads main from origin, then the ancestry, the hub-only commits and the strays", async () => {
      store.addRunCommit({ runId: R.id, repoId: "mc", branch: BRANCH, sha: SHA, at: START });
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": `${BASE}\n`,
        "rev-list": `${SHA}\n`,
        diff: "src/a.ts\0docs/b.md\0package.json\0",
      };
      expect(await withArea().gateFacts(R, SHA)).toEqual({
        ok: true,
        facts: {
          mainSha: MAIN,
          containsMain: true,
          hubOnly: true,
          strays: ["docs/b.md", "package.json"],
          webChanged: false,
        },
      });
      expect(gitCalls).toContainEqual(["ls-remote", "--symref", "origin", "HEAD"]);
      expect(gitCalls).toContainEqual(["merge-base", "--is-ancestor", MAIN, SHA]);
      expect(gitCalls).toContainEqual(["rev-list", SHA, "--not", MAIN]);
      expect(gitCalls).toContainEqual([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        BASE,
        SHA,
        "--",
      ]);
    });

    it("leaves a file this run holds a grant for out of the strays, so its PR is not parked at the gate", async () => {
      store.addRunCommit({ runId: R.id, repoId: "mc", branch: BRANCH, sha: SHA, at: START });
      setRunPathGrants(store, R.id, ["package.json"]);
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": `${BASE}\n`,
        "rev-list": `${SHA}\n`,
        diff: "src/a.ts\0docs/b.md\0package.json\0",
      };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({
        facts: { strays: ["docs/b.md"] },
      });
    });

    it("marks only HUD diffs for the design readiness gate", async () => {
      store.addRunCommit({ runId: R.id, repoId: "mc", branch: BRANCH, sha: SHA, at: START });
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": `${BASE}\n`,
        "rev-list": `${SHA}\n`,
        diff: "apps/web/src/pages/Overview.tsx\0",
      };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({
        ok: true,
        facts: { webChanged: true },
      });
    });

    it("recomputes legacy cached facts to identify a HUD diff", async () => {
      store.addRunCommit({ runId: R.id, repoId: "mc", branch: BRANCH, sha: SHA, at: START });
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": `${BASE}\n`,
        "rev-list": `${SHA}\n`,
        diff: "apps/web/src/pages/Overview.tsx\0",
      };
      expect(
        await withArea().gateFacts(R, SHA, {
          sha: SHA,
          mainSha: MAIN,
          containsMain: true,
          hubOnly: true,
          strays: [],
        }),
      ).toMatchObject({ ok: true, facts: { webChanged: true } });
    });

    it("counts a file the repo lists as protected as a stray", async () => {
      store.addRunCommit({ runId: R.id, repoId: "mc", branch: BRANCH, sha: SHA, at: START });
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: "",
        "merge-base": `${BASE}\n`,
        "rev-list": `${SHA}\n`,
        diff: "src/a.ts\0src/pyproject.toml\0",
      };
      const c = config();
      const seat = c.crew?.sessions[0]?.seats[0];
      if (seat !== undefined) seat.area = ["src/**"];
      if (c.repos[0]) c.repos[0].protectedFiles = ["pyproject.toml"];
      expect(await publisher({ config: c }).gateFacts(R, SHA)).toMatchObject({
        facts: { strays: ["src/pyproject.toml"] },
      });
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({ facts: { strays: [] } });
    });

    it("says a branch behind main does not contain it, and a foreign commit is not hub-only", async () => {
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [ANCESTOR]: exit1,
        "merge-base": `${BASE}\n`,
        "rev-list": `${SHA}\n`,
        diff: "",
      };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({
        ok: true,
        facts: { containsMain: false, hubOnly: false },
      });
    });

    it("fetches main when the clone lacks it", async () => {
      let fetched = false;
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: () => {
          if (!fetched) throw exit1;
          return "";
        },
        fetch: () => {
          fetched = true;
          return "";
        },
        [ANCESTOR]: "",
        "merge-base": `${BASE}\n`,
        "rev-list": "",
        diff: "",
      };
      expect((await withArea().gateFacts(R, SHA)).ok).toBe(true);
      expect(pushed("fetch")).toBe(true);
    });

    it("reuses the known facts when the sha and main's tip are unchanged", async () => {
      gitAnswers = { "ls-remote": lsRemote() };
      const known = {
        sha: SHA,
        mainSha: MAIN,
        containsMain: true,
        hubOnly: true,
        strays: [],
        webChanged: false,
      };
      expect(await withArea().gateFacts(R, SHA, known)).toEqual({
        ok: true,
        facts: { mainSha: MAIN, containsMain: true, hubOnly: true, strays: [], webChanged: false },
      });
      expect(gitCalls).toHaveLength(1);
    });

    it("refuses a sha that is not a sha without running git", async () => {
      expect(await withArea().gateFacts(R, "--upload-pack=x")).toMatchObject({
        ok: false,
        transient: false,
      });
      expect(gitCalls).toEqual([]);
    });

    it("answers a transient refusal when git fails", async () => {
      gitAnswers = { "ls-remote": new Error("network") };
      expect(await withArea().gateFacts(R, SHA)).toMatchObject({ ok: false, transient: true });
    });
  });

  describe("markReady", () => {
    it("runs gh pr ready for the PR", async () => {
      ghAnswers = [ok];
      expect(await publisher().markReady(R)).toEqual({ ok: true });
      expect(ghCalls).toEqual([["pr", "ready", "12", "--repo=o/mc"]]);
    });

    it("checks the live PR head before marking an away PR ready", async () => {
      ghAnswers = [
        () => ({
          code: 0,
          stdout: JSON.stringify({ state: "OPEN", headRefOid: BASE }),
          stderr: "",
        }),
      ];
      expect(await publisher().markReady(R, SHA)).toMatchObject({
        ok: false,
        text: MERGE_HEAD_MOVED,
      });
      expect(ghCalls.some((a) => a[1] === "ready")).toBe(false);
      ghAnswers = [
        () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: SHA }), stderr: "" }),
        ok,
        () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: SHA }), stderr: "" }),
      ];
      expect(await publisher().markReady(R, SHA)).toEqual({ ok: true });
    });

    it("undoes ready when the head moves during the write", async () => {
      ghAnswers = [
        () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: SHA }), stderr: "" }),
        ok,
        () => ({
          code: 0,
          stdout: JSON.stringify({ state: "OPEN", headRefOid: BASE }),
          stderr: "",
        }),
        ok,
      ];
      expect(await publisher().markReady(R, SHA)).toMatchObject({
        ok: false,
        text: MERGE_HEAD_MOVED,
      });
      expect(ghCalls.at(-1)).toEqual(["pr", "ready", "12", "--repo=o/mc", "--undo"]);
    });

    it.each(["unreadable", "moved"])(
      "reports failed rollback after a %s post-ready view",
      async (after) => {
        ghAnswers = [
          () => ({
            code: 0,
            stdout: JSON.stringify({ state: "OPEN", headRefOid: SHA }),
            stderr: "",
          }),
          ok,
          () =>
            after === "unreadable"
              ? { code: 1, stdout: "", stderr: "network" }
              : {
                  code: 0,
                  stdout: JSON.stringify({ state: "OPEN", headRefOid: BASE }),
                  stderr: "",
                },
          () => ({ code: 1, stdout: "", stderr: "undo failed" }),
        ];
        expect(await publisher().markReady(R, SHA)).toEqual({
          ok: false,
          transient: true,
          text: READY_UNDO_FAILED,
        });
        expect(ghCalls.at(-1)).toEqual(["pr", "ready", "12", "--repo=o/mc", "--undo"]);
      },
    );

    it("answers a transient refusal when gh fails, a final one with no PR", async () => {
      ghAnswers = [() => ({ code: 1, stdout: "", stderr: "boom" })];
      expect(await publisher().markReady(R)).toMatchObject({ ok: false, transient: true });
      expect(await publisher().markReady(run())).toMatchObject({ ok: false, transient: false });
    });
  });

  describe("merge", () => {
    const mainSame = () => {
      gitAnswers = {
        "ls-remote": lsRemote(),
        [HAVE_MAIN]: "",
        [`merge-base --is-ancestor ${MAIN} ${SHA}`]: "",
      };
    };

    it("rechecks away mode after reading GitHub and before the merge write", async () => {
      mainSame();
      ghAnswers = [
        () => {
          store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
          return view("OPEN")();
        },
      ];
      expect(await publisher().merge(R, SHA)).toMatchObject({
        ok: false,
        text: AWAY_WRITES_REFUSED,
      });
      expect(ghCalls.some((a) => a[1] === "merge")).toBe(false);
    });

    it("merges with a merge commit, matching the head, and none of the forbidden flags", async () => {
      mainSame();
      ghAnswers = [view("OPEN"), ok];
      expect(await publisher().merge(R, SHA)).toEqual({ ok: true });
      expect(ghCalls).toEqual([
        [
          "pr",
          "view",
          "12",
          "--repo=o/mc",
          "--json",
          "state,headRefOid,baseRefName,headRefName,isCrossRepository,mergeable",
        ],
        ["pr", "merge", "12", "--repo=o/mc", "--merge", `--match-head-commit=${SHA}`],
      ]);
      expect(ghCalls.flat().filter((a) => FORBIDDEN.includes(a))).toEqual([]);
    });

    it("counts a PR that is already merged as success, sending nothing", async () => {
      ghAnswers = [view("MERGED")];
      expect(await publisher().merge(R, SHA)).toEqual({ ok: true });
      expect(ghCalls).toHaveLength(1);
    });

    it("refuses a conflicting PR transiently without attempting to merge", async () => {
      mainSame();
      ghAnswers = [view("OPEN", SHA, { mergeable: "CONFLICTING" })];
      expect(await publisher().merge(R, SHA)).toEqual({
        ok: false,
        text: MERGE_CONFLICTING,
        transient: true,
      });
      expect(MERGE_CONFLICTING).toBe("the PR conflicts with main");
      expect(ghCalls.map((c) => c[1])).toEqual(["view"]);
    });

    it("refuses finally when the head is not the sha", async () => {
      ghAnswers = [view("OPEN", OTHER)];
      expect(await publisher().merge(R, SHA)).toMatchObject({ ok: false, transient: false });
      expect(ghCalls).toHaveLength(1);
    });

    it("refuses finally when the PR is closed", async () => {
      ghAnswers = [view("CLOSED")];
      expect(await publisher().merge(R, SHA)).toMatchObject({ ok: false, transient: false });
    });

    it("merges when main has moved past the branch without checking ancestry", async () => {
      mainSame();
      gitAnswers[`merge-base --is-ancestor ${MAIN} ${SHA}`] = exit1;
      ghAnswers = [view("OPEN"), ok];
      expect(await publisher().merge(R, SHA)).toEqual({ ok: true });
      expect(ghCalls).toContainEqual([
        "pr",
        "merge",
        "12",
        "--repo=o/mc",
        "--merge",
        `--match-head-commit=${SHA}`,
      ]);
      expect(gitCalls.some((args) => args[0] === "merge-base")).toBe(false);
    });

    it("refuses transiently when gh merge fails", async () => {
      mainSame();
      ghAnswers = [view("OPEN"), () => ({ code: 1, stdout: "", stderr: "502" }), view("OPEN")];
      expect(await publisher().merge(R, SHA)).toMatchObject({ ok: false, transient: true });
    });

    it("refuses finally a PR that is cross-repository, from another branch, or into another base", async () => {
      for (const extra of [
        { isCrossRepository: true },
        { headRefName: "feature/7-other" },
        { baseRefName: "release" },
      ]) {
        mainSame();
        ghAnswers = [view("OPEN", SHA, extra)];
        expect(await publisher().merge(R, SHA)).toEqual({
          ok: false,
          text: MERGE_PR_NOT_RUNS,
          transient: false,
        });
        expect(ghCalls.filter((c) => c[1] === "merge")).toEqual([]);
        ghCalls = [];
      }
    });

    it("answers a refused merge with the conflict when GitHub now reports one", async () => {
      mainSame();
      ghAnswers = [
        view("OPEN"),
        () => ({ code: 1, stdout: "", stderr: "Pull request o/mc#12 is not mergeable" }),
        view("OPEN", SHA, { mergeable: "CONFLICTING" }),
      ];
      expect(await publisher().merge(R, SHA)).toEqual({
        ok: false,
        text: MERGE_CONFLICTING,
        transient: true,
      });
      expect(ghCalls.map((c) => c[1])).toEqual(["view", "merge", "view"]);
    });

    it.each(["MERGEABLE", "UNKNOWN"])(
      "keeps gh's own refusal when the PR still reads %s, so the engine counts it",
      async (mergeable) => {
        mainSame();
        ghAnswers = [
          view("OPEN"),
          () => ({ code: 1, stdout: "", stderr: "the base branch policy prohibits the merge" }),
          view("OPEN", SHA, { mergeable }),
        ];
        const r = await publisher().merge(R, SHA);
        expect(r).toMatchObject({ ok: false, transient: true });
        expect(r.ok === false && r.text).not.toBe(MERGE_CONFLICTING);
      },
    );

    it("reports a conflict before the base check", async () => {
      mainSame();
      ghAnswers = [view("OPEN", SHA, { baseRefName: "release", mergeable: "CONFLICTING" })];
      expect(await publisher().merge(R, SHA)).toMatchObject({ text: MERGE_CONFLICTING });
      expect(gitCalls).toEqual([]);
    });

    it("counts a merge whose reply was lost as success when the PR is then merged", async () => {
      mainSame();
      ghAnswers = [view("OPEN"), () => ({ code: 1, stdout: "", stderr: "502" }), view("MERGED")];
      expect(await publisher().merge(R, SHA)).toEqual({ ok: true });
      expect(ghCalls.map((c) => c[1])).toEqual(["view", "merge", "view"]);
    });

    it("merges one at a time in a repo", async () => {
      mainSame();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      ghAnswers = [
        view("OPEN"),
        async () => {
          await held;
          return ok();
        },
        view("OPEN"),
        ok,
      ];
      const p = publisher();
      const first = p.merge(R, SHA);
      const second = p.merge(R, SHA);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ghCalls.map((c) => c[1])).toEqual(["view", "merge"]);
      release();
      await Promise.all([first, second]);
      expect(ghCalls.map((c) => c[1])).toEqual(["view", "merge", "view", "merge"]);
    });
  });

  describe("closeIssue", () => {
    it("closes an open issue as completed", async () => {
      ghAnswers = [() => ({ code: 0, stdout: JSON.stringify({ state: "OPEN" }) }), ok];
      expect(await publisher().closeIssue(R)).toEqual({ ok: true });
      expect(ghCalls).toEqual([
        ["issue", "view", "7", "--repo=o/mc", "--json", "state"],
        ["issue", "close", "7", "--repo=o/mc", "--reason=completed"],
      ]);
    });

    it("counts an issue already closed as success", async () => {
      ghAnswers = [() => ({ code: 0, stdout: JSON.stringify({ state: "CLOSED" }) })];
      expect(await publisher().closeIssue(R)).toEqual({ ok: true });
      expect(ghCalls).toHaveLength(1);
    });

    it("refuses transiently when gh cannot read the issue", async () => {
      ghAnswers = [() => ({ code: 1, stdout: "" })];
      expect(await publisher().closeIssue(R)).toMatchObject({ ok: false, transient: true });
    });
  });

  describe("deleteRemoteBranch", () => {
    const PUSH = [
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/${BRANCH}:${SHA}`,
      "origin",
      "--delete",
      `refs/heads/${BRANCH}`,
    ];

    it("deletes only the merged tip, with a lease", async () => {
      gitAnswers = { "ls-remote": lsRemote(MAIN, SHA), push: "" };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toEqual({ ok: true });
      expect(gitCalls).toContainEqual(PUSH);
      expect(gitCalls.flat().filter((a) => FORBIDDEN.includes(a))).toEqual([]);
    });

    it("counts a branch already gone as success, pushing nothing", async () => {
      gitAnswers = { "ls-remote": lsRemote(MAIN, null) };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toEqual({ ok: true });
      expect(pushed("push")).toBe(false);
    });

    it("keeps a branch someone has pushed to since", async () => {
      gitAnswers = {
        "ls-remote": lsRemote(MAIN, OTHER),
        "rev-parse": "",
        "merge-base": exit1,
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toMatchObject({
        ok: false,
        transient: false,
      });
      expect(pushed("push")).toBe(false);
    });

    it("refuses finally when the lease does not hold at the push", async () => {
      gitAnswers = {
        "ls-remote": lsRemote(MAIN, SHA),
        push: Object.assign(
          new Error("Command failed: git push\nerror: failed to push some refs"),
          {
            code: 1,
            stdout: `!\trefs/heads/${BRANCH}:refs/heads/${BRANCH}\t[rejected] (stale info)\n`,
          },
        ),
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toMatchObject({
        ok: false,
        transient: false,
      });
    });

    it("counts a branch deleted between the check and the push as success", async () => {
      let asked = 0;
      const rejected = Object.assign(new Error("Command failed: git push"), {
        code: 1,
        stdout: `!\trefs/heads/${BRANCH}:refs/heads/${BRANCH}\t[rejected] (stale info)\n`,
      });
      gitAnswers = {
        "ls-remote": () => lsRemote(MAIN, ++asked === 1 ? SHA : null),
        push: rejected,
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toEqual({ ok: true });
      expect(asked).toBe(2);
    });

    it("counts a push that fails because the branch has gone as success", async () => {
      let asked = 0;
      gitAnswers = {
        "ls-remote": () => lsRemote(MAIN, ++asked === 1 ? SHA : null),
        push: new Error("error: unable to delete: remote ref does not exist"),
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toEqual({ ok: true });
    });

    it("keeps the push's refusal when the re-check cannot read origin", async () => {
      let asked = 0;
      gitAnswers = {
        "ls-remote": () => {
          if (++asked === 1) return lsRemote(MAIN, SHA);
          throw new Error("fatal: unable to access origin");
        },
        push: Object.assign(new Error("Command failed: git push"), {
          code: 1,
          stdout: `!\trefs/heads/${BRANCH}:refs/heads/${BRANCH}\t[rejected] (stale info)\n`,
        }),
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toMatchObject({
        ok: false,
        transient: false,
      });
      expect(asked).toBe(2);
    });

    it("still refuses finally when the branch is still there after a refused push", async () => {
      gitAnswers = {
        "ls-remote": lsRemote(MAIN, SHA),
        push: Object.assign(new Error("Command failed: git push"), {
          code: 1,
          stdout: `!\trefs/heads/${BRANCH}:refs/heads/${BRANCH}\t[rejected] (stale info)\n`,
        }),
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toMatchObject({
        ok: false,
        transient: false,
      });
    });

    it("refuses a branch that is not of the run's shape, or is another issue's", async () => {
      const p = publisher();
      for (const branch of ["main", "feature/8-other", "release/7-x", null]) {
        expect(await p.deleteRemoteBranch(run({ branch }), SHA)).toMatchObject({
          ok: false,
          transient: false,
        });
      }
      expect(gitCalls).toEqual([]);
    });

    it("never deletes origin's default branch", async () => {
      gitAnswers = {
        "ls-remote": `ref: refs/heads/${BRANCH}\tHEAD\n${MAIN}\tHEAD\n${SHA}\trefs/heads/${BRANCH}\n`,
      };
      expect(await publisher().deleteRemoteBranch(R, SHA)).toMatchObject({ ok: false });
      expect(pushed("push")).toBe(false);
    });
  });

  describe("deleteLocalBranch", () => {
    it("deletes the branch when its tip is the merged sha", async () => {
      gitAnswers = { "rev-parse": `${SHA}\n`, branch: "" };
      expect(await publisher().deleteLocalBranch(MERGED_RUN)).toEqual({ ok: true });
      expect(gitCalls).toContainEqual(["branch", "-D", BRANCH]);
    });

    it("deletes it when its tip is an ancestor of main", async () => {
      gitAnswers = {
        "rev-parse": `${OTHER}\n`,
        "ls-remote": lsRemote(),
        "merge-base": "",
        branch: "",
      };
      expect(await publisher().deleteLocalBranch(MERGED_RUN)).toEqual({ ok: true });
      expect(gitCalls).toContainEqual(["merge-base", "--is-ancestor", OTHER, MAIN]);
    });

    it("fetches main when the clone lacks the merge commit, then deletes", async () => {
      let fetched = false;
      gitAnswers = {
        "rev-parse": (args) => {
          if (args.includes(`${MAIN}^{commit}`) && !fetched) throw exit1;
          return `${OTHER}\n`;
        },
        "ls-remote": lsRemote(),
        fetch: () => {
          fetched = true;
          return "";
        },
        "merge-base": "",
        branch: "",
      };
      expect(await publisher().deleteLocalBranch(MERGED_RUN)).toEqual({ ok: true });
      expect(pushed("fetch")).toBe(true);
      expect(gitCalls).toContainEqual(["branch", "-D", BRANCH]);
    });

    it("refuses transiently when the fetch fails", async () => {
      gitAnswers = {
        "rev-parse": (args) => {
          if (args.includes(`${MAIN}^{commit}`)) throw exit1;
          return `${OTHER}\n`;
        },
        "ls-remote": lsRemote(),
        fetch: new Error("network"),
      };
      expect(await publisher().deleteLocalBranch(MERGED_RUN)).toMatchObject({
        ok: false,
        transient: true,
      });
      expect(pushed("branch")).toBe(false);
    });

    it("keeps a branch with commits that were not merged", async () => {
      gitAnswers = {
        "rev-parse": `${OTHER}\n`,
        "ls-remote": lsRemote(),
        "merge-base": exit1,
      };
      expect(await publisher().deleteLocalBranch(MERGED_RUN)).toMatchObject({
        ok: false,
        transient: false,
      });
      expect(pushed("branch")).toBe(false);
    });

    it("counts a branch already gone as success", async () => {
      gitAnswers = { "rev-parse": exit1 };
      expect(await publisher().deleteLocalBranch(MERGED_RUN)).toEqual({ ok: true });
    });

    it("refuses a branch not of the run's shape", async () => {
      expect(await publisher().deleteLocalBranch(run({ branch: "main" }))).toMatchObject({
        ok: false,
      });
      expect(gitCalls).toEqual([]);
    });
  });
});

describe("fileMinorFindings", () => {
  const setup = () => {
    const r = run({ loop: { phase: "done", epoch: 0, prNumber: 12 } as Run["loop"] });
    store.upsertRun(r);
    mkdirSync(join(dir, "crew"), { recursive: true });
    return r;
  };
  it("files the exact findings with area and chore labels, adds the project item, and remembers it", async () => {
    const r = setup();
    const lines = "- `a.ts:2` — Keep this.\n- `b.ts` — Also this.";
    let file = "";
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({
          body: `${MINOR_HEADING}\n\n${lines}\n\n## Tests\n- Passed`,
          labels: [{ name: "area:server" }, { name: "bug" }],
        }),
      }),
      () => ({ code: 0, stdout: "[]" }),
      (args) => {
        expect(args).toContain("--title=Tech debt: minor findings from #12");
        expect(args).toContain("--label=area:server,chore");
        file = args.find((a) => a.startsWith("--body-file="))?.slice(12) ?? "";
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(readFileSync(file, "utf8")).toBe(`Minor findings from #12.\n\n${lines}\n`);
        return { code: 0, stdout: "https://github.com/o/mc/issues/81\n" };
      },
      (args) => {
        expect(store.run(r.id)?.loop?.minorIssueNumber).toBe(81);
        expect(args).toEqual([
          "project",
          "item-add",
          "1",
          "--owner=o",
          "--url=https://github.com/o/mc/issues/81",
        ]);
        return { code: 0, stdout: "" };
      },
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12)).toEqual({
      ok: true,
      issueNumber: 81,
    });
    expect(existsSync(file)).toBe(false);
    expect(store.run(r.id)?.loop?.minorIssueNumber).toBe(81);
    // a later pass files nothing new but re-adds the item, in case a restart cut the first add
    ghAnswers.push((args) => {
      expect(args).toEqual([
        "project",
        "item-add",
        "1",
        "--owner=o",
        "--url=https://github.com/o/mc/issues/81",
      ]);
      return { code: 0, stdout: "" };
    });
    expect(await createPublisher(deps()).fileMinorFindings(store.run(r.id) ?? r, 12)).toEqual({
      ok: true,
      issueNumber: 81,
    });
    expect(ghCalls).toHaveLength(5);
  });
  it("appends findings to the configured open rolling tech-debt issue", async () => {
    const r = setup();
    let file = "";
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
      }),
      (args) => {
        expect(args).toEqual(["issue", "view", "656", "--repo=o/mc", "--json=state,comments"]);
        return { code: 0, stdout: JSON.stringify({ state: "OPEN", comments: [] }) };
      },
      (args) => {
        expect(args.slice(0, 3)).toEqual(["issue", "comment", "656"]);
        file = args.find((a) => a.startsWith("--body-file="))?.slice(12) ?? "";
        expect(readFileSync(file, "utf8")).toBe("Minor findings from #12.\n\n- Finding\n");
        return { code: 0, stdout: "" };
      },
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12, 656)).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
  });
  it("falls back to a per-PR issue when no rolling issue is open", async () => {
    const r = setup();
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
      }),
      (args) => {
        expect(args.slice(0, 2)).toEqual(["issue", "list"]);
        return { code: 0, stdout: "[]" };
      },
      () => ({ code: 0, stdout: "https://github.com/o/mc/issues/81\n" }),
      () => ({ code: 0, stdout: "" }),
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12)).toMatchObject({
      ok: true,
      issueNumber: 81,
    });
  });
  it("appends findings to the rolling issue discovered by title", async () => {
    const r = setup();
    let file = "";
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
      }),
      (args) => {
        expect(args.slice(0, 2)).toEqual(["issue", "list"]);
        return {
          code: 0,
          stdout: JSON.stringify([{ number: 656, title: "Tech debt: the rolling list" }]),
        };
      },
      (args) => {
        expect(args).toContain("656");
        return { code: 0, stdout: JSON.stringify({ state: "OPEN", comments: [] }) };
      },
      (args) => {
        expect(args.slice(0, 3)).toEqual(["issue", "comment", "656"]);
        file = args.find((a) => a.startsWith("--body-file="))?.slice(12) ?? "";
        expect(readFileSync(file, "utf8")).toBe("Minor findings from #12.\n\n- Finding\n");
        return { code: 0, stdout: "" };
      },
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12)).toEqual({ ok: true });
    expect(ghCalls.some((args) => args[1] === "create")).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
  it("does not append duplicate findings when the merge event repeats", async () => {
    const r = setup();
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
      }),
      () => ({
        code: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          comments: [{ body: "Minor findings from #12.\n\n- Finding\n" }],
        }),
      }),
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12, 656)).toEqual({ ok: true });
    expect(ghCalls).toHaveLength(2);
  });
  it("falls back when the configured rolling tech-debt issue is closed", async () => {
    const r = setup();
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
      }),
      () => ({ code: 0, stdout: JSON.stringify({ state: "CLOSED", comments: [] }) }),
      () => ({ code: 0, stdout: "https://github.com/o/mc/issues/81\n" }),
      () => ({ code: 0, stdout: "" }),
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12, 656)).toMatchObject({
      ok: true,
      issueNumber: 81,
    });
  });
  it.each([
    "GraphQL: Could not resolve to an issue or pull request with the number of 656. (repository.issue)",
    "GraphQL: Could not resolve to an Issue with the number of 656. (repository.issue)",
    "HTTP 404: Not Found",
  ])(
    "falls back when the configured rolling tech-debt issue no longer exists: %s",
    async (stderr) => {
      const r = setup();
      ghAnswers.push(
        () => ({
          code: 0,
          stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
        }),
        () => ({ code: 1, stdout: "", stderr }),
        () => ({ code: 0, stdout: "https://github.com/o/mc/issues/81\n" }),
        () => ({ code: 0, stdout: "" }),
      );
      expect(await createPublisher(deps()).fileMinorFindings(r, 12, 656)).toMatchObject({
        ok: true,
        issueNumber: 81,
      });
    },
  );
  it("refuses, without filing, on any other gh error viewing the rolling issue", async () => {
    const r = setup();
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n\n- Finding`, labels: [] }),
      }),
      () => ({ code: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded for user ID 1." }),
    );
    expect(await createPublisher(deps()).fileMinorFindings(r, 12, 656)).toMatchObject({
      ok: false,
    });
    expect(ghCalls).toHaveLength(2);
  });
  it("refuses RETRO's fallback instead of silently dropping findings", async () => {
    ghAnswers.push(() => ({
      code: 0,
      stdout: JSON.stringify({
        body: `${MINOR_HEADING}\n\nRETRO logged 2 minor findings; they are listed in Mission Control.`,
        labels: [],
      }),
    }));
    expect(await createPublisher(deps()).fileMinorFindings(setup(), 12)).toMatchObject({
      ok: false,
    });
    expect(ghCalls).toHaveLength(1);
  });
  it.each([0, 1, 2])(
    "recovers a creation interrupted before saving its number (%s matches)",
    async (matches) => {
      const r = setup();
      ghAnswers.push(
        () => ({
          code: 0,
          stdout: JSON.stringify({ body: `${MINOR_HEADING}\n- Finding`, labels: [] }),
        }),
        () => ({ code: 0, stdout: "[]" }),
        () => {
          expect(store.run(r.id)?.loop).toHaveProperty("minorIssueCreation", { prNumber: 12 });
          throw new Error("connection lost after issue creation");
        },
      );
      expect(await createPublisher(deps()).fileMinorFindings(r, 12)).toMatchObject({ ok: false });
      expect(store.run(r.id)?.loop).toHaveProperty("minorIssueCreation", { prNumber: 12 });
      ghCalls.length = 0;
      ghAnswers.push((args) => {
        expect(args.slice(0, 2)).toEqual(["issue", "list"]);
        expect(args).toContain("--state=all");
        return {
          code: 0,
          stdout: JSON.stringify([
            ...Array.from({ length: matches }, (_, i) => ({
              number: 81 + i,
              title: "Tech debt: minor findings from #12",
              body: "Minor findings from #12.\n\n- Finding\n",
            })),
            {
              number: 90,
              title: "Tech debt: minor findings from #120",
              body: "Minor findings from #12.\n",
            },
            {
              number: 91,
              title: "Tech debt: minor findings from #12",
              body: "Minor findings from #120.\n",
            },
          ]),
        };
      });
      if (matches === 1) ghAnswers.push(() => ({ code: 0, stdout: "" }));
      const result = await createPublisher(deps()).fileMinorFindings(store.run(r.id) ?? r, 12);
      expect(result).toMatchObject(matches === 1 ? { ok: true, issueNumber: 81 } : { ok: false });
      expect(ghCalls[0]?.slice(0, 2)).toEqual(["issue", "list"]);
      expect(ghCalls.some((args) => args[1] === "create")).toBe(false);
    },
  );
  it("files nothing without a minor section", async () => {
    ghAnswers.push(() => ({
      code: 0,
      stdout: JSON.stringify({ body: "## Tests\n- Passed", labels: [] }),
    }));
    expect(await createPublisher(deps()).fileMinorFindings(setup(), 12)).toEqual({ ok: true });
    expect(ghCalls).toHaveLength(1);
  });
  it("returns a failed create and removes the body file", async () => {
    let file = "";
    ghAnswers.push(
      () => ({
        code: 0,
        stdout: JSON.stringify({ body: `${MINOR_HEADING}\n- Finding`, labels: [] }),
      }),
      () => ({ code: 0, stdout: "[]" }),
      (args) => {
        file = args.find((a) => a.startsWith("--body-file="))?.slice(12) ?? "";
        return { code: 1, stdout: "", stderr: "denied" };
      },
    );
    expect(await createPublisher(deps()).fileMinorFindings(setup(), 12)).toMatchObject({
      ok: false,
      text: expect.stringContaining("denied"),
    });
    expect(existsSync(file)).toBe(false);
  });
  it("refuses a draft workspace without calling GitHub", async () => {
    const c = config();
    const repo = c.repos[0];
    if (repo === undefined) throw new Error("missing repo");
    repo.autonomy = "draft";
    expect(await createPublisher(deps({ config: c })).fileMinorFindings(setup(), 12)).toMatchObject(
      { ok: false },
    );
    expect(ghCalls).toEqual([]);
  });
});
