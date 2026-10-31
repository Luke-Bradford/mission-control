import "./temp-home.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_FLIGHT_COMMS_POINTER,
  ASK_FLIGHT_SELF,
  ASKED_FLIGHT,
  AWAY_PLAN_REFUSED,
  AWAY_SETTING,
  alreadyOnOriginText,
  CALL_FLIGHT_SELF,
  CALLED_FLIGHT,
  type CheckDrop,
  COMMS_MESSAGE_MAX,
  COMMS_QUESTION_TO_FLIGHT,
  CREW_MODES,
  commitMarkersText,
  commitUnresolvedText,
  commsCutMarker,
  DEFAULT_AWAY,
  DEFAULT_PROFILES,
  EVIDENCE_IN_CI,
  EVIDENCE_NO_COMMIT,
  EVIDENCE_NO_LOOP,
  EVIDENCE_PARKED,
  EVIDENCE_RECORDED,
  evidenceTextText,
  evidenceUncommittedText,
  FINDINGS_ALREADY,
  FINDINGS_BLOCKING_NEEDS_FAIL,
  FINDINGS_DROPPED,
  FINDINGS_FAIL_NEEDS_BLOCKING,
  FINDINGS_NOT_A_REVIEW,
  FINDINGS_RECORDED,
  FLIGHT_SIGNALS_SETTING,
  findingFileText,
  fixKey,
  MC_BAD_ARGS,
  MC_COMMIT_MERGE_UNKNOWN,
  MC_COMMS_READ_MAX,
  MC_PLAN_ALREADY,
  MC_PLAN_BODY_UNCLOSED,
  MC_PLAN_GH_FAILED,
  MC_PLAN_ISSUE_CLOSED,
  MC_PLAN_MAX,
  MC_PLAN_NO_ROOM,
  MC_PLAN_NO_TESTS,
  MC_PLAN_NOT_FAO,
  MC_PLAN_PROFILE_ONLY,
  MC_PLAN_WRITTEN,
  MC_PLAN_WRITTEN_CONTINUE,
  MC_PR_UNCLOSED,
  MC_PUSH_CHECKS,
  MC_PUSH_FAILED,
  MC_PUSH_MERGE,
  MC_PUSH_NO_COMMIT,
  MC_PUSH_ROOT,
  MC_REMOVE_REFUSED,
  MC_RUN_ENDED,
  MC_SYNC_OFF,
  MC_SYNC_UP_TO_DATE,
  MC_TEXT_MAX,
  MC_TOOL_GRANTS,
  MC_TOOL_NAMES,
  MC_TOOLS,
  NEW_LOOP,
  originMovedText,
  PROFILE_PAIR_TEXT,
  planByLine,
  planFewTestsText,
  planMissingPathsText,
  planNoProfilesText,
  planTooLongText,
  planUnknownProfileText,
  planUnsafePathsText,
  planWrittenText,
  prNamedRefText,
  prNotifyText,
  prSecretText,
  pushChecksText,
  pushPrDoneText,
  type ReviewFinding,
  type Run,
  type RunLoop,
  readOnlyToolText,
  removeLinkedText,
  removeMissingText,
  removeNotFileText,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, crewGuardDeps } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { TICKET_BODY_MAX } from "../src/collectors/github.ts";
import { type CcConfig, crewSeatMode } from "../src/config.ts";
import { createFlightTools } from "../src/flight/tools.ts";
import { TestLock } from "../src/guard/lock.ts";
import { attentionItems, NO_LOCK } from "../src/hud.ts";
import { createGh, type GhRunner, ghCommand } from "../src/mcp/gh.ts";
import type { McTool, McToolContext } from "../src/mcp/server.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { createMcTools, type McToolsDeps, openDraftPr, pushRun } from "../src/mcp/tools.ts";
import { setRunPathGrants } from "../src/path-grants.ts";
import { ProfilesError } from "../src/profiles.ts";
import { CREW_GIT_SLOW_MS, MC_MERGE_AUTHOR } from "../src/runtime/checkouts.ts";
import { crewGit } from "../src/runtime/git.ts";
import { runSeatGrants } from "../src/runtime/grants.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const BRANCH = "feature/42-fix-the-stop-race";
const RUN = "guido-1:20261020T115000Z";
const SESSION = "mc-crew";
const REVERT = "Revert what you didn't mean to change.";
/** A push refused for a commit the commit tool did not make: the Blocked note's reason, for the operator. */
const FOREIGN = (sha: string) =>
  `Not pushed: ${sha.slice(0, 7)} was not made by the commit tool, so the branch cannot be pushed. Look at the branch in the seat's worktree, then message the seat.`;
/**
 * The tail of every push secret refusal. It is the Blocked note's reason, so it speaks to the operator:
 * the commit is made, only they can take the value out of history, and the seat resumes on their word.
 */
const SECRET_ASK =
  "The commit is already made and the seat cannot rewrite history, so only you can take it out of the branch; then message the seat to carry on.";

let dir: string;
let clone: string;
let wt: string;
let store: Store;
let bus: ChangeBus;
let emitted: string[];
let tools: McTool[];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });

const write = (rel: string, text: string) => {
  mkdirSync(join(wt, rel, ".."), { recursive: true });
  writeFileSync(join(wt, rel), text);
};

const head = () => git(wt, "rev-parse", "HEAD").trim();
const staged = () => git(wt, "diff", "--cached", "--name-only");
const strayKey = (path: string) =>
  `stray:${createHash("sha256").update(`${SESSION}\0${path}`).digest("hex").slice(0, 16)}`;

function config(): CcConfig {
  return {
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
    repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 8,
      sessions: [
        {
          id: SESSION,
          repoId: "mc",
          checkout: clone,
          seats: [
            {
              id: "guido-1",
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              area: ["apps/**"],
            },
            {
              id: "guido-2",
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              area: ["web/**"],
            },
            { id: "retro", role: "RETRO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    },
  };
}

const run = (over: Partial<Run> = {}): Run => ({
  id: RUN,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 600_000,
  endedAt: null,
  status: "running",
  sessionId: "cli-1",
  model: "haiku",
  branch: BRANCH,
  ticket: "mc#42",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

/** The tools' log lines (every test): none may hold a known secret. */
let logs: string[];

/** A gh no test outside the push suite should reach: it never runs anything. */
const noGh: GhRunner = async (args) => {
  throw new Error(`gh ${args.join(" ")} was not expected`);
};

function deps(over: Partial<McToolsDeps> = {}): McToolsDeps {
  return {
    config: config(),
    store,
    bus,
    inClone: (_checkout, fn) => fn(),
    now: () => NOW,
    gh: noGh,
    dbPath: join(dir, "data", "mc.sqlite"),
    knownSecrets: async () => [],
    checks: async () => [],
    log: (line) => logs.push(line),
    ...over,
  };
}

function make(over: Partial<McToolsDeps> = {}): McTool[] {
  return createMcTools(deps(over));
}

const tool = (name: string, ts: McTool[] = tools): McTool => {
  const t = ts.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const CTX: McToolContext = { seatId: "guido-1", runId: RUN };
/** A seat with a live run (its run row unended, its seat row naming it). */
const liveSeat = (seatId: string, runId: string) => {
  store.upsertRun(run({ id: runId, agentId: seatId }));
  store.setSeatSession({
    seatId,
    runId,
    cliSessionId: null,
    state: "running",
    reason: null,
    worktree: null,
    updatedAt: NOW,
  });
};
const SPECIAL = "is a symlink or a nested repository; the crew commits plain files only.";
const SPECIALS = "are a symlink or a nested repository; the crew commits plain files only.";
/** A nested repository with one commit at `rel` in the worktree. */
const nestedRepo = (rel: string) => {
  const at = join(wt, rel);
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q");
  writeFileSync(join(at, "f.txt"), "f\n");
  git(at, "add", "-A");
  git(at, "commit", "-qm", "inner");
};
const commit = (message: unknown, ts: McTool[] = tools, ctx: McToolContext = CTX) =>
  tool("commit", ts).call(ctx, message === undefined ? {} : { message });

const rm = (remove: unknown, message = "chore: drop", ts: McTool[] = tools, ctx = CTX) =>
  tool("commit", ts).call(ctx, { message, remove });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-tools-")));
  clone = join(dir, "clone");
  wt = join(dir, "worktrees", "guido-1-42");
  mkdirSync(join(dir, "data"));
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  git(clone, "config", "user.name", "Test Operator");
  git(clone, "config", "user.email", "you@example.com");
  git(clone, "config", "maintenance.auto", "false");
  git(clone, "config", "gc.auto", "0");
  for (const [rel, text] of Object.entries({
    "apps/a.ts": "a\n",
    "web/b.ts": "b\n",
    "docs/c.md": "c\n",
    "package.json": "{}\n",
    "README.md": "hi\n",
  })) {
    mkdirSync(join(clone, rel, ".."), { recursive: true });
    writeFileSync(join(clone, rel), text);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "init");
  git(clone, "worktree", "add", "-q", "-b", BRANCH, wt);
  store = new Store(join(dir, "data", "mc.sqlite"));
  store.upsertRun(run());
  store.setSeatSession({
    seatId: "guido-1",
    runId: RUN,
    cliSessionId: "cli-1",
    state: "running",
    reason: null,
    worktree: wt,
    updatedAt: NOW,
  });
  bus = new ChangeBus();
  logs = [];
  emitted = [];
  bus.subscribe((t) => emitted.push(t));
  tools = make();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the mc tools", () => {
  it("serves the mode tools under the names the CLI prefixes, and no push or draft_pr", () => {
    expect(tools.map((t) => [t.name, t.modes])).toEqual([
      [MC_TOOL_NAMES.commsRead, ["writer", "read-only", "scratch"]],
      [MC_TOOL_NAMES.commsInbox, ["writer", "read-only", "scratch"]],
      [MC_TOOL_NAMES.commsSend, ["writer", "read-only", "scratch"]],
      [MC_TOOL_NAMES.commsReact, ["writer", "read-only", "scratch"]],
      ["commit", ["writer"]],
      ["sync_main", ["writer"]],
      ["ask_flight", ["writer", "read-only"]],
      ["call_flight", ["writer", "read-only", "scratch"]],
      ["report_evidence", ["writer", "read-only"]],
      [MC_TOOL_NAMES.previewBrowser, ["scratch"]],
      [MC_TOOL_NAMES.restoreFile, ["scratch"]],
      ["report_findings", ["scratch"]],
      ["report_plan", []],
    ]);
    expect(tools.map((t) => `mcp__mc__${t.name}`)).toEqual([
      MC_TOOLS.commsRead,
      MC_TOOLS.commsInbox,
      MC_TOOLS.commsSend,
      MC_TOOLS.commsReact,
      MC_TOOLS.commit,
      MC_TOOLS.syncMain,
      MC_TOOLS.askFlight,
      MC_TOOLS.callFlight,
      MC_TOOLS.reportEvidence,
      MC_TOOLS.previewBrowser,
      MC_TOOLS.restoreFile,
      MC_TOOLS.reportFindings,
      MC_TOOLS.reportPlan,
    ]);
  });

  it("tool modes match MC_TOOL_GRANTS", () => {
    const modesWith = (key: "base" | "grantable", name: string) =>
      CREW_MODES.filter((m) => (MC_TOOL_GRANTS[m][key] as readonly string[]).includes(name));
    for (const t of tools) {
      expect([...t.modes], t.name).toEqual(modesWith("base", t.name));
      // FLIGHT's separate sync_main entry owns the read-only grant and its runId/basis schema.
      expect([...(t.grantable ?? [])], t.name).toEqual(
        t.name === "sync_main" ? [] : modesWith("grantable", t.name),
      );
    }
    const flight = createFlightTools({
      ...deps(),
      login: "me",
      engine: null,
      supervisor: {
        message: vi.fn(),
        busy: () => [],
        startRun: vi.fn(),
        endRun: vi.fn(),
        endAsideRun: vi.fn(),
        resumeRun: vi.fn(),
        interrupt: vi.fn(),
      },
      rules: vi.fn(),
      fetchTicket: vi.fn(),
      board: { move: vi.fn() },
    });
    expect(flight.find((t) => t.name === "sync_main")?.grantable).toEqual(["read-only"]);
  });
});

describe("sync_main", () => {
  it("sync_main hands the run to deps.syncMain, and answers MC_SYNC_OFF without it", async () => {
    const calls: string[] = [];
    const ts = make({
      syncMain: async (id) => {
        calls.push(id);
        return { text: MC_SYNC_UP_TO_DATE };
      },
    });
    expect(await tool("sync_main", ts).call(CTX, {})).toEqual({ text: MC_SYNC_UP_TO_DATE });
    expect(calls).toEqual([RUN]);
    expect(await tool("sync_main").call(CTX, {})).toEqual({ text: MC_SYNC_OFF, isError: true });
    liveSeat("retro", "retro:1");
    expect(await tool("sync_main", ts).call({ seatId: "retro", runId: "retro:1" }, {})).toEqual({
      text: readOnlyToolText("sync_main"),
      isError: true,
    });
    expect((await tool("sync_main", ts).call(CTX, { runId: RUN })).text).toMatch(
      /^Invalid arguments:/,
    );
    store.upsertRun(run({ endedAt: NOW }));
    expect(await tool("sync_main", ts).call(CTX, {})).toEqual({
      text: MC_RUN_ENDED,
      isError: true,
    });
    expect(calls).toEqual([RUN]);
  });
});

describe("commit", () => {
  it("commits everything in the area, as the seat, and records the commit for the run", async () => {
    const base = head();
    write("apps/a.ts", "a2\n");
    write("apps/new.ts", "n\n");
    const r = await commit("feat: the new thing\n\nWith a body.");
    const sha = head();
    expect(sha).not.toBe(base);
    expect(r).toEqual({ text: `Committed ${sha.slice(0, 7)} on ${BRANCH}: feat: the new thing` });
    expect(git(wt, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%P|%B").trim()).toBe(
      `GUIDO-1 (Mission Control) <you@example.com>|GUIDO-1 (Mission Control) <you@example.com>|${base}|feat: the new thing\n\nWith a body.`,
    );
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual([
      "apps/a.ts",
      "apps/new.ts",
    ]);
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(store.runCommits(RUN)).toEqual([sha]);
    expect(store.branchCommits("mc", BRANCH)).toEqual(new Set([sha]));
    expect(emitted).toContain("agents");
  });

  it("keeps every run's commits on the branch: a later run on the ticket counts the earlier one's", async () => {
    write("apps/a.ts", "a2\n");
    await commit("one");
    const first = head();
    store.upsertRun(run({ endedAt: NOW, status: "ok" }));
    const second = "guido-1:20261020T130000Z";
    store.upsertRun(run({ id: second, seq: 2 }));
    const row = store.seatSession("guido-1");
    if (row === null) throw new Error("no seat row");
    store.setSeatSession({ ...row, runId: second });
    write("apps/a.ts", "a3\n");
    await commit("two", tools, { seatId: "guido-1", runId: second });
    expect(store.runCommits(RUN)).toEqual([first]);
    expect(store.runCommits(second)).toEqual([head()]);
    expect(store.branchCommits("mc", BRANCH)).toEqual(new Set([first, head()]));
    expect(store.branchCommits("mc", "feature/other").size).toBe(0);
  });

  it("never stages a .pnpm-store, at the top or nested: committed around it, no stray", async () => {
    write(".pnpm-store/v11/index.db", "db\n");
    write("apps/.pnpm-store/v11/index.db", "db\n");
    write("apps/a.ts", "a2\n");
    const r = await commit("feat: x");
    expect(r.text).toMatch(/^Committed /);
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual([
      "apps/a.ts",
    ]);
    expect(store.strays()).toEqual([]);
    // left where pnpm put them, untracked
    expect(git(wt, "status", "--porcelain", "-uall").split("\n").filter(Boolean)).toEqual([
      "?? .pnpm-store/v11/index.db",
      "?? apps/.pnpm-store/v11/index.db",
    ]);
  });

  it("never stages Python caches or a .venv, at the top or nested", async () => {
    write("pkg/__pycache__/a.pyc", "cache\n");
    write(".pytest_cache/v", "cache\n");
    write(".venv/x", "cache\n");
    write(".ruff_cache/x", "cache\n");
    write("apps/.mypy_cache/x", "cache\n");
    for (const prefix of ["", "pkg/"]) {
      for (const file of [
        ".coverage",
        ".hypothesis/x",
        "demo.egg-info/PKG-INFO",
        ".tox/x",
        ".nox/x",
        "htmlcov/index.html",
        ".ipynb_checkpoints/test.ipynb",
      ]) {
        write(`${prefix}${file}`, "cache\n");
      }
    }
    write("apps/a.ts", "a2\n");
    const r = await commit("feat: x");
    expect(r.text).toMatch(/^Committed /);
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual([
      "apps/a.ts",
    ]);
    expect(store.strays()).toEqual([]);
  });

  it("answers Nothing to commit when only a .pnpm-store changed, recording no stray", async () => {
    write(".pnpm-store/v11/index.db", "db\n");
    expect(await commit("feat: x")).toEqual({ text: "Nothing to commit." });
    expect(store.strays()).toEqual([]);
    expect(staged()).toBe("");
  });

  it("still stages a deletion with the store excluded", async () => {
    write(".pnpm-store/v11/index.db", "db\n");
    rmSync(join(wt, "apps", "a.ts"));
    expect((await commit("chore: drop a")).text).toMatch(/^Committed /);
    expect(git(wt, "show", "--name-status", "--format=", "HEAD").trim()).toBe("D\tapps/a.ts");
  });

  it("answers Nothing to commit when nothing changed", async () => {
    const base = head();
    expect(await commit("feat: nothing")).toEqual({ text: "Nothing to commit." });
    expect(head()).toBe(base);
    expect(store.runCommits(RUN)).toEqual([]);
  });

  it("refuses a path outside the area: index reset, a stray recorded, nothing committed", async () => {
    const base = head();
    write("apps/a.ts", "a2\n");
    write("docs/c.md", "c2\n");
    const r = await commit("feat: x");
    expect(r).toEqual({
      text: `Not committed: docs/c.md is outside your area (apps/**).\n${REVERT}`,
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
    // the seat's changes are left in its worktree, unstaged
    expect(git(wt, "status", "--porcelain").split("\n").filter(Boolean)).toEqual([
      " M apps/a.ts",
      " M docs/c.md",
    ]);
    expect(store.strays()).toEqual([
      {
        key: strayKey("docs/c.md"),
        sessionId: SESSION,
        path: "docs/c.md",
        agentId: "guido-1",
        kind: "outside",
        at: NOW,
      },
    ]);
    expect(store.runCommits(RUN)).toEqual([]);
    expect(emitted).toContain("attention");
  });

  it("refuses each kind in its own line: outside, another writer's area, protected", async () => {
    const base = head();
    write("apps/a.ts", "a2\n");
    write("docs/c.md", "c2\n");
    write("README.md", "hi2\n");
    write("web/b.ts", "b2\n");
    write("package.json", '{"x":1}\n');
    write("apps/package.json", "{}\n");
    const r = await commit("feat: x");
    expect(r.text).toBe(
      [
        "Not committed: README.md and docs/c.md are outside your area (apps/**).",
        "Not committed: web/b.ts is in GUIDO-2's area.",
        "Not committed: apps/package.json and package.json are protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs them.",
        REVERT,
      ].join("\n"),
    );
    expect(r.isError).toBe(true);
    expect(head()).toBe(base);
    expect(staged()).toBe("");
    // protected files are refused, not strays
    expect(store.strays().map((s) => [s.path, s.kind])).toEqual([
      ["README.md", "outside"],
      ["docs/c.md", "outside"],
      ["web/b.ts", "other-area"],
    ]);
  });

  it("commits a protected file and one outside the area when this run holds a grant for them", async () => {
    setRunPathGrants(store, RUN, ["package.json", "README.md"]);
    write("package.json", '{"x":1}\n');
    write("README.md", "hi2\n");
    const r = await commit("chore: root files");
    expect(r.isError).toBeUndefined();
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "",
      "README.md",
      "package.json",
    ]);
  });

  it("keeps refusing the rest while a grant is held: another file, a nested package.json", async () => {
    setRunPathGrants(store, RUN, ["package.json"]);
    write("package.json", '{"x":1}\n');
    write("docs/c.md", "c2\n");
    write("apps/package.json", "{}\n");
    const r = await commit("feat: x");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("docs/c.md is outside your area");
    expect(r.text).toContain("apps/package.json is protected");
    expect(r.text).not.toContain("Not committed: package.json");
  });

  it("refuses the same file to a run that holds no grant, though the seat's other run had one", async () => {
    setRunPathGrants(store, "guido-1:20261019T100000Z", ["package.json"]);
    write("package.json", '{"x":1}\n');
    const r = await commit("chore: root");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("package.json is protected");
  });

  it("refuses one protected file, inside the area or nested, as it", async () => {
    write("apps/tsconfig.json", "{}\n");
    expect((await commit("chore: ts")).text).toBe(
      `Not committed: apps/tsconfig.json is protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs it.\n${REVERT}`,
    );
    expect(store.strays()).toEqual([]);
    write("apps/tsconfig.json", "{}\n");
    rmSync(join(wt, "apps/tsconfig.json"));
    write("apps/.github/workflows/ci.yml", "on: push\n");
    expect((await commit("ci")).text).toBe(
      `Not committed: apps/.github/workflows/ci.yml is protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs it.\n${REVERT}`,
    );
  });

  const withProtected = () => {
    const c = config();
    if (c.repos[0]) c.repos[0].protectedFiles = ["pyproject.toml"];
    return make({ config: c });
  };

  it("refuses a file the repo lists as protected, and commits it in a repo that does not", async () => {
    const base = head();
    write("apps/pyproject.toml", "[project]\n");
    expect((await commit("chore: py", withProtected())).text).toBe(
      `Not committed: apps/pyproject.toml is protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs it.\n${REVERT}`,
    );
    expect(head()).toBe(base);
    expect(store.strays()).toEqual([]);
    expect((await commit("chore: py")).text).toMatch(/^Committed /);
  });

  it("refuses to remove a file the repo lists as protected", async () => {
    write("apps/pyproject.toml", "[project]\n");
    await commit("chore: py");
    const r = await rm(["apps/pyproject.toml"], "chore: drop", withProtected());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Not committed: apps/pyproject.toml is protected");
  });

  it("names ten paths per group, then and {n} more", async () => {
    for (let i = 1; i <= 12; i++) write(`docs/f${String(i).padStart(2, "0")}.md`, "x\n");
    const names = Array.from(
      { length: 10 },
      (_, i) => `docs/f${String(i + 1).padStart(2, "0")}.md`,
    );
    expect((await commit("docs")).text).toBe(
      `Not committed: ${names.join(", ")} and 2 more are outside your area (apps/**).\n${REVERT}`,
    );
    expect(store.strays()).toHaveLength(12);
  });

  it("sees both sides of a rename: out of the area, and into it", async () => {
    const base = head();
    renameSync(join(wt, "apps/a.ts"), join(wt, "docs/a.ts"));
    expect((await commit("move")).text).toBe(
      `Not committed: docs/a.ts is outside your area (apps/**).\n${REVERT}`,
    );
    renameSync(join(wt, "docs/a.ts"), join(wt, "apps/a.ts"));
    renameSync(join(wt, "docs/c.md"), join(wt, "apps/c.md"));
    expect((await commit("move")).text).toBe(
      `Not committed: docs/c.md is outside your area (apps/**).\n${REVERT}`,
    );
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });

  it("checks what add staged: a file changed after the seat looked, before the add, is refused", async () => {
    const base = head();
    write("apps/a.ts", "a2\n");
    const late: McToolsDeps["git"] = async (cwd, args, common, o) => {
      if (args[0] === "add") write("docs/late.md", "late\n");
      return crewGit(cwd, args, common, o);
    };
    const r = await commit("feat: x", make({ git: late }));
    expect(r.text).toBe(`Not committed: docs/late.md is outside your area (apps/**).\n${REVERT}`);
    expect(head()).toBe(base);
    expect(staged()).toBe("");
    expect(store.strays().map((s) => s.path)).toEqual(["docs/late.md"]);
  });

  it("commits the index it checked: a file changed after the check is not in the commit", async () => {
    write("apps/a.ts", "a2\n");
    const late: McToolsDeps["git"] = async (cwd, args, common, o) => {
      if (args.includes("commit")) write("docs/after.md", "after\n");
      return crewGit(cwd, args, common, o);
    };
    const r = await commit("feat: x", make({ git: late }));
    expect(r.text).toMatch(/^Committed [0-9a-f]{7} on /);
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").trim()).toBe("apps/a.ts");
    expect(git(wt, "status", "--porcelain").trim()).toBe("?? docs/after.md");
  });

  it("refuses a worktree whose HEAD left the run's branch, branch or detached", async () => {
    write("apps/a.ts", "a2\n");
    git(wt, "checkout", "-q", "-b", "elsewhere");
    const text = `Not committed: your worktree is not on ${BRANCH}.`;
    expect(await commit("feat: x")).toEqual({ text, isError: true });
    git(wt, "checkout", "-q", "--detach");
    expect(await commit("feat: x")).toEqual({ text, isError: true });
    expect(git(wt, "rev-list", "--count", "--all").trim()).toBe("1");
    expect(staged()).toBe("");
  });

  it("clears the seat's strays on the commit that reverts them, and keeps the ones still there", async () => {
    write("docs/c.md", "c2\n");
    write("README.md", "hi2\n");
    await commit("feat: x");
    expect(store.strays().map((s) => s.path)).toEqual(["README.md", "docs/c.md"]);
    git(wt, "checkout", "--", "README.md");
    await commit("feat: x");
    expect(store.strays().map((s) => s.path)).toEqual(["docs/c.md"]);
    git(wt, "checkout", "--", "docs/c.md");
    write("apps/a.ts", "a2\n");
    expect((await commit("feat: x")).text).toMatch(/^Committed /);
    expect(store.strays()).toEqual([]);
  });

  it("leaves another seat's strays alone", async () => {
    store.addStrays([
      { sessionId: SESSION, path: "docs/z.md", agentId: "guido-2", kind: "outside", at: 1 },
    ]);
    write("apps/a.ts", "a2\n");
    await commit("feat: x");
    expect(store.strays().map((s) => s.path)).toEqual(["docs/z.md"]);
  });

  it("validates the message: 1 to 2000 characters, not blank", async () => {
    write("apps/a.ts", "a2\n");
    const base = head();
    for (const bad of [undefined, "", "   \n", "x".repeat(2001), 42]) {
      const r = await commit(bad);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Invalid arguments: /);
    }
    expect((await tool("commit").call(CTX, { message: "ok", extra: 1 })).isError).toBe(true);
    expect(head()).toBe(base);
    expect((await commit("x".repeat(2000))).text).toMatch(/^Committed /);
  });

  it("refuses a run that is not the seat's live one, running no git", async () => {
    write("apps/a.ts", "a2\n");
    let ran = 0;
    const counting: McToolsDeps["git"] = async (cwd, args, common, o) => {
      ran++;
      return crewGit(cwd, args, common, o);
    };
    const ts = make({ git: counting });
    // an earlier run of the seat, never closed: the seat's row names another run now
    store.upsertRun(run({ id: "guido-1:old" }));
    const stale = await commit("feat: x", ts, { seatId: "guido-1", runId: "guido-1:old" });
    expect(stale).toEqual({ text: "This run has ended.", isError: true });
    store.upsertRun(run({ endedAt: NOW, status: "ok" }));
    expect(await commit("feat: x", ts)).toEqual({ text: "This run has ended.", isError: true });
    expect(ran).toBe(0);
  });

  it("runs inside the clone's queue", async () => {
    write("apps/a.ts", "a2\n");
    const queued: string[] = [];
    const ts = make({
      inClone: async (checkout, fn) => {
        queued.push(checkout);
        return fn();
      },
    });
    await commit("feat: x", ts);
    expect(queued).toEqual([clone]);
  });
});

describe("commit: another open run changed the same file", () => {
  const RUN2 = "guido-2:20261020T115500Z";
  const CTX2: McToolContext = { seatId: "guido-2", runId: RUN2 };
  let wt2: string;
  const twins = (): CcConfig => {
    const c = config();
    const seat = c.crew?.sessions[0]?.seats[1];
    if (seat !== undefined) seat.area = ["apps/**"];
    return c;
  };
  const write2 = (rel: string, text: string) => {
    mkdirSync(join(wt2, rel, ".."), { recursive: true });
    writeFileSync(join(wt2, rel), text);
  };
  const clashLine = (paths: string, verb = "is") =>
    `Note: ${paths} ${verb} also changed by GUIDO-2 on mc#43, which is still open; the two PRs may conflict when the second one is merged, and the operator or the controller will resolve it.`;

  beforeEach(() => {
    wt2 = join(dir, "worktrees", "guido-2-43");
    git(clone, "worktree", "add", "-q", "-b", "feature/43-other", wt2);
    store.upsertRun(
      run({ id: RUN2, agentId: "guido-2", branch: "feature/43-other", ticket: "mc#43" }),
    );
    store.setSeatSession({
      seatId: "guido-2",
      runId: RUN2,
      cliSessionId: "cli-2",
      state: "running",
      reason: null,
      worktree: wt2,
      updatedAt: NOW,
    });
    tools = make({ config: twins() });
  });

  it("commits a path another open run changed in its worktree, with a note", async () => {
    write2("apps/a.ts", "theirs\n");
    write("apps/a.ts", "mine\n");
    const base = head();
    const r = await commit("feat: x");
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/^Committed /);
    expect(r.text.endsWith(`\n\n${clashLine("apps/a.ts")}`)).toBe(true);
    expect(head()).not.toBe(base);
    expect(store.runCommits(RUN)).toEqual([head()]);
  });

  it("commits a path another open run committed on its branch, with a note", async () => {
    write2("apps/a.ts", "theirs\n");
    expect((await commit("feat: theirs", tools, CTX2)).text).toMatch(/^Committed /);
    write("apps/a.ts", "mine\n");
    const r = await commit("feat: x");
    expect(r.isError).toBeUndefined();
    expect(r.text.endsWith(`\n\n${clashLine("apps/a.ts")}`)).toBe(true);
    expect(store.runCommits(RUN)).toEqual([head()]);
  });

  it("counts a new untracked file and a rename's source", async () => {
    write2("apps/n.ts", "theirs\n");
    write2("apps/a.ts", "theirs\n");
    write("apps/n.ts", "mine\n");
    renameSync(join(wt, "apps/a.ts"), join(wt, "apps/z.ts"));
    const r = await commit("feat: x");
    expect(r.isError).toBeUndefined();
    expect(r.text.endsWith(`\n\n${clashLine("apps/a.ts and apps/n.ts", "are")}`)).toBe(true);
  });

  it("commits when the other run changed other files only", async () => {
    write2("apps/b.ts", "theirs\n");
    write("apps/a.ts", "mine\n");
    expect((await commit("feat: x")).text).toMatch(/^Committed /);
  });

  it("commits without a note when the other run cannot be read", async () => {
    write2("apps/b.ts", "theirs\n");
    write("apps/a.ts", "mine\n");
    const base = head();
    const ts = make({
      config: twins(),
      knownSecrets: async () => [LOCAL],
      git: async (cwd, args, common, o) => {
        if (cwd === wt2) throw Object.assign(new Error("boom"), { stderr: `fatal: ${LOCAL}` });
        return crewGit(cwd, args, common, o);
      },
    });
    const r = await commit("feat: x", ts);
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/^Committed /);
    expect(r.text).not.toContain("Note:");
    expect(head()).not.toBe(base);
    expect(store.runCommits(RUN)).toEqual([head()]);
    const line = logs.find((l) => l.includes("guido-2:"));
    expect(line).toBeDefined();
    expect(logs.join("\n")).not.toContain(LOCAL);
  });

  it("removes a file another open run's change clashes with, with a note", async () => {
    write2("apps/a.ts", "theirs\n");
    const base = head();
    const r = await rm(["apps/a.ts"]);
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/^Removed apps\/a\.ts\.\nCommitted /);
    expect(r.text.endsWith(`\n\n${clashLine("apps/a.ts")}`)).toBe(true);
    expect(head()).not.toBe(base);
    expect(existsSync(join(wt, "apps/a.ts"))).toBe(false);
  });
});

describe("commit: remove", () => {
  const nameStatus = () => git(wt, "show", "--name-status", "--format=", "HEAD").trim();

  it("removes a file in the area and commits it with the other changes", async () => {
    write("apps/new.ts", "n\n");
    const r = await rm(["apps/a.ts"], "chore: drop a");
    expect(r).toEqual({
      text: `Removed apps/a.ts.\nCommitted ${head().slice(0, 7)} on ${BRANCH}: chore: drop a`,
    });
    expect(nameStatus()).toBe("D\tapps/a.ts\nA\tapps/new.ts");
    expect(existsSync(join(wt, "apps/a.ts"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("refuses before deleting anything: outside, another's area, protected, non-ASCII", async () => {
    const base = head();
    const r = await rm(["docs/c.md", "web/b.ts", "package.json", "apps/é.ts"]);
    expect(r).toEqual({
      text: [
        "Not committed: docs/c.md is outside your area (apps/**).",
        "Not committed: web/b.ts is in GUIDO-2's area.",
        "Not committed: package.json is protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs it.",
        "Not committed: apps/é.ts is not plain ASCII paths; the crew commits ASCII paths only.",
        MC_REMOVE_REFUSED,
      ].join("\n"),
      isError: true,
    });
    expect(existsSync(join(wt, "docs/c.md"))).toBe(true);
    expect(existsSync(join(wt, "web/b.ts"))).toBe(true);
    expect(head()).toBe(base);
    expect(staged()).toBe("");
    expect(store.strays()).toEqual([]);
    expect(store.guardHits(0)).toEqual([]);
  });

  it("refuses a folder and a path that is nowhere", async () => {
    expect(await rm(["apps", "apps/nope.ts"])).toEqual({
      text: [
        removeNotFileText(["apps"]),
        removeMissingText(["apps/nope.ts"]),
        MC_REMOVE_REFUSED,
      ].join("\n"),
      isError: true,
    });
    expect(existsSync(join(wt, "apps/a.ts"))).toBe(true);
  });

  it("refuses a tracked file under a symlinked folder, and the target survives", async () => {
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out/a.ts"), "outside\n");
    rmSync(join(wt, "apps"), { recursive: true });
    symlinkSync(join(dir, "out"), join(wt, "apps"));
    expect(await rm(["apps/a.ts"])).toEqual({
      text: `${removeLinkedText(["apps/a.ts"])}\n${MC_REMOVE_REFUSED}`,
      isError: true,
    });
    expect(existsSync(join(dir, "out/a.ts"))).toBe(true);
  });

  it("refuses a path whose case differs from the tracked file's", async () => {
    const r = await rm(["Docs/c.md"]);
    // linked on a case-insensitive disk, missing on a case-sensitive one: refused either way
    expect(r.isError).toBe(true);
    expect(r.text).toContain(MC_REMOVE_REFUSED);
    expect(existsSync(join(wt, "docs/c.md"))).toBe(true);
  });

  it("removes a new file outside the area and clears its stray", async () => {
    write("docs/new.md", "n\n");
    expect((await commit("x")).isError).toBe(true);
    expect(store.strays()).toHaveLength(1);
    expect(await rm(["docs/new.md"])).toEqual({ text: "Removed docs/new.md.\nNothing to commit." });
    expect(store.strays()).toEqual([]);
    expect(existsSync(join(wt, "docs/new.md"))).toBe(false);
  });

  it("accepts a file already gone, with no Removed line", async () => {
    rmSync(join(wt, "apps/a.ts"));
    expect((await rm(["apps/a.ts"])).text).toMatch(/^Committed /);
    expect(nameStatus()).toBe("D\tapps/a.ts");
  });

  it("keeps a removal when the commit is refused for another path", async () => {
    write("docs/c.md", "c2\n");
    expect(await rm(["apps/a.ts"], "x")).toEqual({
      text: `Removed apps/a.ts.\nNot committed: docs/c.md is outside your area (apps/**).\n${REVERT}`,
      isError: true,
    });
    expect(existsSync(join(wt, "apps/a.ts"))).toBe(false);
    write("docs/c.md", "c\n");
    expect((await commit("chore: drop a")).text).toMatch(/^Committed /);
    expect(nameStatus()).toBe("D\tapps/a.ts");
  });

  it("validates remove", async () => {
    const base = head();
    const bad: unknown[] = [
      ["/a.ts"],
      ["apps/../a.ts"],
      ["apps/"],
      ["./a.ts"],
      [""],
      ["a//b"],
      Array.from({ length: 51 }, (_, i) => `apps/f${i}.ts`),
      "apps/a.ts",
      [42],
    ];
    for (const remove of bad) {
      const r = await rm(remove);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Invalid arguments: remove/);
    }
    expect(head()).toBe(base);
    expect(existsSync(join(wt, "apps/a.ts"))).toBe(true);
  });

  it("drops duplicates", async () => {
    expect((await rm(["apps/a.ts", "apps/a.ts"])).text).toMatch(
      /^Removed apps\/a\.ts\.\nCommitted /,
    );
  });

  it("describes remove in the schema", () => {
    const t = tool("commit");
    expect(t.inputSchema).toMatchObject({
      required: ["message"],
      properties: {
        remove: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 1024 },
          description:
            "Files to delete, as paths from the repo's top (apps/server/src/old.ts); files only, not folders. Each must be in your area, unless it is a new file your branch doesn't have yet.",
        },
      },
    });
    expect(t.description).toBe(
      "Commit every change in your worktree to your run's branch. Mission Control makes the commit: you cannot run git commit yourself. To delete files, list them in remove: Mission Control deletes them first, then commits the deletions with your other changes. A change outside your area, in another agent's area, to a protected file (build, install and CI config), or a symlink or nested repository refuses the whole commit and is reported to the operator; revert it and commit again. A file another agent's open run has also changed does not stop the commit: the answer carries a note naming that agent and ticket, as the two PRs may conflict at merge. A file in remove that may not be deleted refuses the call before anything is deleted; files deleted before a later refusal stay deleted.",
    );
  });
});

/** The test crew with a FLIGHT seat (a watch seat) beside the others. */
const withFlight = (): CcConfig => {
  const c = config();
  const session = c.crew?.sessions[0];
  if (session === undefined) throw new Error("no session");
  session.seats.push({
    id: "flight-1",
    role: "FLIGHT",
    accountId: "claude-main",
    model: "haiku",
    area: [],
  });
  return c;
};

describe("ask_flight", () => {
  const ask = (args: unknown) => tool("ask_flight").call(CTX, args);

  it("records the question and tells the seat to carry on", async () => {
    expect(await ask({ question: "Lanes per customer, or one global list?" })).toEqual({
      text: ASKED_FLIGHT,
    });
    expect(ASKED_FLIGHT).toMatch(/^Asked FLIGHT\./);
    expect(store.openQuestions()).toEqual([
      {
        id: expect.any(Number),
        agentId: "guido-1",
        runId: RUN,
        text: "Lanes per customer, or one global list?",
        at: NOW,
        passedAt: null,
      },
    ]);
    expect(emitted).toContain("attention");
  });

  it("mirrors the question to FLIGHT, not CAPCOM, about its run's ticket (#758)", async () => {
    tools = make({ config: withFlight() });
    await ask({ question: "Lanes per customer?" });
    expect(store.comms(0)).toEqual([
      {
        at: NOW,
        from: "guido-1",
        to: "flight-1",
        ticket: "mc#42",
        text: ASK_FLIGHT_COMMS_POINTER,
      },
    ]);
    expect(emitted).toContain("agents");
  });

  it("with no FLIGHT seat, mirrors it to CAPCOM: nobody else can answer it", async () => {
    await ask({ question: "Lanes per customer?" });
    expect(store.comms(0)).toEqual([
      {
        at: NOW,
        from: "guido-1",
        to: "CAPCOM",
        ticket: "mc#42",
        text: ASK_FLIGHT_COMMS_POINTER,
      },
    ]);
  });

  it("keeps a long question in its record and sends FLIGHT a short pointer", async () => {
    tools = make({ config: withFlight() });
    const question = "x".repeat(2000);
    await ask({ question });
    expect(store.openQuestions()[0]?.text).toBe(question);
    const comms = store.comms(0)[0]?.text ?? "";
    expect(Array.from(comms).length).toBeLessThanOrEqual(COMMS_MESSAGE_MAX);
    expect(comms).not.toBe(question);
  });

  it("refuses FLIGHT itself, recording nothing: FLIGHT briefs the operator instead", async () => {
    tools = make({ config: withFlight() });
    liveSeat("flight-1", "flight-1:1");
    const t = tool("ask_flight");
    expect(t.offeredTo?.("flight-1")).toBe(false);
    expect(t.offeredTo?.("guido-1")).toBe(true);
    expect(t.offeredTo?.("retro")).toBe(true);
    expect(await t.call({ seatId: "flight-1", runId: "flight-1:1" }, { question: "x?" })).toEqual({
      text: ASK_FLIGHT_SELF,
      isError: true,
    });
    expect(store.openQuestions()).toEqual([]);
    expect(store.comms(0)).toEqual([]);
  });

  it("refuses a seat's question to CAPCOM over comms_send, pointing at ask_flight (#758)", async () => {
    tools = make({ config: withFlight() });
    const send = (ctx: McToolContext, args: unknown) => tool("comms_send").call(ctx, args);
    expect(await send(CTX, { to: "CAPCOM", text: "Which lane?", label: "question" })).toEqual({
      text: COMMS_QUESTION_TO_FLIGHT,
      isError: true,
    });
    expect(store.comms(0)).toEqual([]);
    // a plain line, or a question to FLIGHT, still goes
    expect((await send(CTX, { to: "CAPCOM", text: "Done with #42." })).isError).toBeUndefined();
    expect(
      (await send(CTX, { to: "flight-1", text: "Which lane?", label: "question" })).isError,
    ).toBeUndefined();
    // FLIGHT's own question to CAPCOM is its channel to the operator
    liveSeat("flight-1", "flight-1:1");
    expect(
      (
        await send(
          { seatId: "flight-1", runId: "flight-1:1" },
          { to: "CAPCOM", text: "Merge #551?", label: "question" },
        )
      ).isError,
    ).toBeUndefined();
  });

  it("counts FLIGHT's comms toward the runaway breaker and refuses them while it is tripped", async () => {
    tools = make({ config: withFlight() });
    liveSeat("flight-1", "flight-1:1");
    const flight = { seatId: "flight-1", runId: "flight-1:1" };
    const line = { to: "CAPCOM", text: "Same line" };
    for (let i = 0; i < 5; i++)
      expect((await tool("comms_send").call(flight, line)).isError).toBeUndefined();
    expect(await tool("comms_send").call(flight, line)).toMatchObject({
      isError: true,
      text: expect.stringContaining("runaway breaker"),
    });
    // a developer seat's comms are not FLIGHT's writes
    expect((await tool("comms_send").call(CTX, line)).isError).toBeUndefined();
  });

  it("stops and counts FLIGHT's comms_react like its comms_send", async () => {
    tools = make({ config: withFlight() });
    liveSeat("flight-1", "flight-1:1");
    const flight = { seatId: "flight-1", runId: "flight-1:1" };
    const id = (await tool("comms_send").call(CTX, { to: "flight-1", text: "ping" })).text.replace(
      /^Sent (.*)\.$/,
      "$1",
    );
    const react = (c = flight) => tool("comms_react").call(c, { id, reaction: "seen" });
    // five identical reactions trip the breaker; the sixth is refused and writes nothing
    for (let i = 0; i < 5; i++) expect((await react()).isError).toBeUndefined();
    expect(await react()).toMatchObject({
      isError: true,
      text: expect.stringContaining("runaway breaker"),
    });
    // a developer seat's reactions are not FLIGHT's writes
    expect((await react(CTX)).isError).toBeUndefined();
  });

  it("closes a seat's open questions when it is answered, and only that seat's", async () => {
    await ask({ question: "one?" });
    liveSeat("retro", "retro:1");
    await tool("ask_flight").call({ seatId: "retro", runId: "retro:1" }, { question: "two?" });
    store.answerQuestions("guido-1", NOW + 1);
    expect(store.openQuestions().map((q) => q.text)).toEqual(["two?"]);
  });

  it("refuses a run that has ended, or is not the seat's live one, recording nothing", async () => {
    store.upsertRun(run({ endedAt: NOW, status: "ok" }));
    expect(await ask({ question: "one?" })).toEqual({ text: "This run has ended.", isError: true });
    const other = await tool("ask_flight").call(
      { seatId: "guido-1", runId: "guido-1:none" },
      { question: "two?" },
    );
    expect(other).toEqual({ text: "This run has ended.", isError: true });
    expect(store.openQuestions()).toEqual([]);
    expect(store.comms(0)).toEqual([]);
  });

  it("validates the question: 1 to 2000 characters, not blank", async () => {
    for (const bad of [{}, { question: "" }, { question: " " }, { question: "x".repeat(2001) }]) {
      const r = await ask(bad);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Invalid arguments: /);
    }
    expect(store.openQuestions()).toEqual([]);
  });
});

describe("call_flight", () => {
  const call = (args: unknown, ctx: McToolContext = CTX) => tool("call_flight").call(ctx, args);
  const calls = () => JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}").signals;

  it("keeps the call as a wake reason for FLIGHT, with the seat's reason and its ticket", async () => {
    tools = make({ config: withFlight() });
    expect(await call({ reason: "I need a change in apps/web, outside my area" })).toEqual({
      text: CALLED_FLIGHT,
    });
    expect(Object.values(calls())).toEqual([
      expect.objectContaining({
        kind: "seat_call",
        key: `guido-1:${NOW}`,
        toldAt: null,
        evidence: "guido-1 calls FLIGHT about mc#42: I need a change in apps/web, outside my area",
      }),
    ]);
    expect(emitted).toContain("attention");
  });

  it("takes the ref the seat gives, and counts the same call twice as one", async () => {
    tools = make({ config: withFlight() });
    await call({ reason: "I dispute the finding", ref: "mc#77" });
    await call({ reason: "I dispute the finding", ref: "mc#77" });
    expect(Object.values(calls())).toHaveLength(1);
    expect(JSON.stringify(calls())).toContain("about mc#77");
  });

  it("is offered to every seat but FLIGHT, a review's scratch seat included, and refuses FLIGHT itself", async () => {
    tools = make({ config: withFlight() });
    liveSeat("flight-1", "flight-1:1");
    const t = tool("call_flight");
    expect(t.offeredTo?.("flight-1")).toBe(false);
    for (const seat of ["guido-1", "retro"]) expect(t.offeredTo?.(seat)).toBe(true);
    expect(await call({ reason: "x" }, { seatId: "flight-1", runId: "flight-1:1" })).toEqual({
      text: CALL_FLIGHT_SELF,
      isError: true,
    });
    expect(calls() ?? {}).toEqual({});
  });

  it("counts a repeat as a new call once the first has been told, and as one until then", async () => {
    tools = make({ config: withFlight() });
    await call({ reason: "same blocker", ref: "mc#77" });
    await call({ reason: "same blocker", ref: "mc#77" });
    expect(Object.values(calls())).toHaveLength(1);
    const saved = JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}");
    for (const x of Object.values(saved.signals) as { toldAt: number | null }[]) x.toldAt = NOW;
    store.setSetting(`${FLIGHT_SIGNALS_SETTING}:mc`, JSON.stringify(saved));
    tools = make({ config: withFlight(), now: () => NOW + 30 * 60_000 });
    await call({ reason: "same blocker", ref: "mc#77" });
    const kept = Object.values(calls()) as { toldAt: number | null }[];
    expect(kept).toHaveLength(2);
    expect(kept.filter((x) => x.toldAt === null)).toHaveLength(1);
  });

  it("refuses an empty reason", async () => {
    tools = make({ config: withFlight() });
    expect((await call({ reason: "" })).isError).toBe(true);
    expect(calls() ?? {}).toEqual({});
  });
});

describe("through /mcp", () => {
  it("never offers FLIGHT ask_flight; a seat beside it still has it (#758)", async () => {
    const cfg = withFlight();
    tools = make({ config: cfg });
    const tokens = new RunTokens();
    const flight = tokens.issue("flight-1", "flight-1:1");
    const reader = tokens.issue("retro", "retro:1");
    liveSeat("flight-1", "flight-1:1");
    const app = buildApp({
      config: cfg,
      store,
      bus,
      tokens,
      mcpTools: () => tools,
      seatMode: (id) => crewSeatMode(cfg, id),
    });
    await app.ready();
    try {
      const rpc = (tok: string, method: string, params?: unknown) =>
        app
          .inject({
            method: "POST",
            url: "/mcp",
            headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
            payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
          .then((r) => r.json());
      const names = async (tok: string) =>
        (await rpc(tok, "tools/list")).result.tools.map((t: { name: string }) => t.name);
      expect(await names(flight)).not.toContain("ask_flight");
      expect(await names(reader)).toContain("ask_flight");
      const call = await rpc(flight, "tools/call", {
        name: "ask_flight",
        arguments: { question: "x?" },
      });
      expect(call.error.message).toBe("unknown tool");
      expect(store.openQuestions()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("offers each seat mode its Comms tools; commit runs end to end", async () => {
    const cfg = config();
    const tokens = new RunTokens();
    const writer = tokens.issue("guido-1", RUN);
    const reader = tokens.issue("retro", "retro:1");
    const app = buildApp({
      config: cfg,
      store,
      bus,
      tokens,
      mcpTools: () => tools,
      seatMode: (id) => crewSeatMode(cfg, id),
    });
    await app.ready();
    try {
      const rpc = (tok: string, method: string, params?: unknown) =>
        app
          .inject({
            method: "POST",
            url: "/mcp",
            headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
            payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
          .then((r) => r.json());
      const names = async (tok: string) =>
        (await rpc(tok, "tools/list")).result.tools.map((t: { name: string }) => t.name);
      expect(await names(writer)).toEqual([
        "comms_read",
        "comms_inbox",
        "comms_send",
        "comms_react",
        "commit",
        "sync_main",
        "ask_flight",
        "call_flight",
        "report_evidence",
      ]);
      expect(
        (
          await rpc(writer, "tools/call", {
            name: MC_TOOL_NAMES.restoreFile,
            arguments: { path: "apps/a.ts" },
          })
        ).error.message,
      ).toBe("unknown tool");
      expect(await names(reader)).toEqual([
        "comms_read",
        "comms_inbox",
        "comms_send",
        "comms_react",
        "ask_flight",
        "call_flight",
        "report_evidence",
      ]);
      write("apps/a.ts", "a2\n");
      const r = await rpc(writer, "tools/call", {
        name: "commit",
        arguments: { message: "feat: e2e" },
      });
      expect(r.result.content[0].text).toBe(
        `Committed ${head().slice(0, 7)} on ${BRANCH}: feat: e2e`,
      );
      const denied = await rpc(reader, "tools/call", {
        name: "commit",
        arguments: { message: "x" },
      });
      expect(denied.error.message).toBe("unknown tool");
    } finally {
      await app.close();
    }
  });

  it("uses crewGuardDeps run grants to list and call planner and FLIGHT tools", async () => {
    const cfg = config();
    cfg.crew?.sessions[0]?.seats.push(
      { id: "fao-1", role: "FAO", accountId: "claude-main", model: "haiku", area: [] },
      { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "haiku", area: [] },
    );
    const tokens = new RunTokens();
    const planner = tokens.issue("fao-1", "fao:mcp");
    const flight = tokens.issue("flight-1", "flight:mcp");
    const reportPlan = vi.fn(async () => ({ text: "plan recorded" }));
    const logDecision = vi.fn(async () => ({ text: "decision recorded" }));
    const mcpTools: McTool[] = [
      {
        name: MC_TOOL_NAMES.reportPlan,
        description: "record a plan",
        inputSchema: {},
        modes: [],
        grantable: ["read-only"],
        call: reportPlan,
      },
      {
        name: MC_TOOL_NAMES.logDecision,
        description: "record a decision",
        inputSchema: {},
        modes: [],
        grantable: ["read-only"],
        call: logDecision,
      },
    ];
    const app = buildApp({
      config: cfg,
      store,
      bus,
      ...crewGuardDeps(cfg, tokens, new TestLock(), store),
      mcpTools: () => mcpTools,
    });
    await app.ready();
    try {
      const rpc = (token: string, method: string, params?: object) =>
        app
          .inject({
            method: "POST",
            url: "/mcp",
            headers: { authorization: `Bearer ${token}` },
            payload: { jsonrpc: "2.0", id: 1, method, params },
          })
          .then((r) => r.json());
      const names = async (token: string) =>
        (await rpc(token, "tools/list")).result.tools.map((t: { name: string }) => t.name);

      expect(await names(planner)).toContain(MC_TOOL_NAMES.reportPlan);
      expect(await names(flight)).toContain(MC_TOOL_NAMES.logDecision);
      expect(
        (await rpc(planner, "tools/call", { name: MC_TOOL_NAMES.reportPlan, arguments: {} })).result
          .content[0].text,
      ).toBe("plan recorded");
      expect(
        (await rpc(flight, "tools/call", { name: MC_TOOL_NAMES.logDecision, arguments: {} })).result
          .content[0].text,
      ).toBe("decision recorded");
      expect(reportPlan).toHaveBeenCalledWith({ seatId: "fao-1", runId: "fao:mcp" }, {});
      expect(logDecision).toHaveBeenCalledWith({ seatId: "flight-1", runId: "flight:mcp" }, {});
    } finally {
      await app.close();
    }
  });
});

describe("Comms seat tools", () => {
  const read = (args: unknown = {}, ts = tools, ctx = CTX) =>
    tool("comms_read", ts).call(ctx, args);
  const inbox = (args: unknown = {}, ts = tools, ctx = CTX) =>
    tool("comms_inbox", ts).call(ctx, args);
  const send = (args: unknown, ts = tools, ctx = CTX) => tool("comms_send", ts).call(ctx, args);
  const react = (args: unknown, ts = tools, ctx = CTX) => tool("comms_react", ts).call(ctx, args);

  it("refuses a long message and directs the seat to its structured report", async () => {
    expect(await send({ to: "crew", text: "x".repeat(COMMS_MESSAGE_MAX + 1) })).toEqual({
      text: "Not sent: messages are limited to 1,200 characters; put findings, plans or evidence in report_findings, report_plan or report_evidence and send a short pointer.",
      isError: true,
    });
    expect(store.comms(0)).toEqual([]);
  });

  it("reads recent stored crew, direct and mentioned context without leaking other DMs", async () => {
    store.addComms({ at: NOW - 4, from: "retro", to: "crew", ticket: null, text: "crew" });
    store.addComms({ at: NOW - 3, from: "guido-2", to: "guido-1", ticket: null, text: "direct" });
    store.addComms({
      at: NOW - 2,
      from: "retro",
      to: "CAPCOM",
      ticket: null,
      text: "mentioned @guido-1",
      mentions: ["guido-1"],
    });
    store.addComms({ at: NOW - 1, from: "guido-2", to: "retro", ticket: null, text: "private" });
    const result = await read({ limit: 2 });
    const parsed = JSON.parse(result.text) as { messages: { text: string; id: string }[] };
    expect(parsed.messages.map((message) => message.text)).toEqual([
      "direct",
      "mentioned @guido-1",
    ]);
    expect(parsed.messages.every((message) => message.id.startsWith("comms:"))).toBe(true);
    expect((await read({}, tools, { ...CTX, runId: "gone" })).isError).toBe(true);
  });

  it("reads only its direct, mentioned, replied and pinned inbox rows, newest last", async () => {
    const own = store.addComms({
      at: NOW - 8,
      from: "guido-1",
      to: "retro",
      ticket: null,
      text: "my message",
    });
    store.addComms({ at: NOW - 7, from: "retro", to: "crew", ticket: null, text: "crew" });
    store.addComms({ at: NOW - 6, from: "retro", to: "guido-1", ticket: null, text: "direct" });
    store.addComms({
      at: NOW - 5,
      from: "retro",
      to: "crew",
      ticket: null,
      text: "mentioned",
      mentions: ["guido-1"],
    });
    store.addComms({
      at: NOW - 4,
      from: "retro",
      to: "guido-2",
      ticket: null,
      text: "reply",
      replyTo: own?.id,
    });
    const pinned = store.addComms({
      at: NOW - 3,
      from: "guido-2",
      to: "retro",
      ticket: null,
      text: "pin",
    });
    store.addComms({ at: NOW - 2, from: "guido-2", to: "retro", ticket: null, text: "other" });
    if (pinned === null) throw new Error("expected stored pin");
    store.setCommsPinned(pinned.id, true, "CAPCOM", NOW - 1);

    const parsed = JSON.parse((await inbox()).text) as {
      messages: { text: string; pinned: boolean; unread: boolean }[];
    };
    expect(
      parsed.messages.map((message) => [message.text, message.pinned, message.unread]),
    ).toEqual([
      ["direct", false, true],
      ["mentioned", false, true],
      ["reply", false, true],
      ["pin", true, true],
    ]);
  });

  it("keeps rework targeted at an aside run from a newer run on the same seat", async () => {
    store.addComms({
      at: NOW - 1,
      from: "CAPCOM",
      to: "guido-1",
      ticket: "mc#42",
      text: "Rework the review findings.",
      targetRunId: RUN,
    });
    const newer = "guido-1:newer";
    liveSeat("guido-1", newer);
    const current = JSON.parse((await read({}, tools, { ...CTX, runId: newer })).text) as {
      messages: { text: string }[];
    };
    expect(current.messages.map((message) => message.text)).not.toContain(
      "Rework the review findings.",
    );

    liveSeat("guido-1", RUN);
    const resumed = JSON.parse((await read()).text) as { messages: { text: string }[] };
    expect(resumed.messages.map((message) => message.text)).toContain(
      "Rework the review findings.",
    );
  });

  it("shows crew messages, pinned rows and replies to the seat's own messages, and no others", async () => {
    const own = store.addComms({
      at: NOW - 6,
      from: "guido-1",
      to: "retro",
      ticket: null,
      text: "mine",
    });
    store.addComms({ at: NOW - 5, from: "retro", to: "crew", ticket: null, text: "crew" });
    const pinned = store.addComms({
      at: NOW - 4,
      from: "guido-2",
      to: "retro",
      ticket: null,
      text: "pinned private",
    });
    store.addComms({
      at: NOW - 3,
      from: "retro",
      to: "guido-2",
      ticket: null,
      text: "reply to mine",
      replyTo: own?.id,
    });
    store.addComms({ at: NOW - 2, from: "guido-2", to: "retro", ticket: null, text: "private" });
    if (own === null || pinned === null) throw new Error("expected stored rows");
    store.setCommsPinned(pinned.id, true, "CAPCOM", NOW - 1);
    const pins = vi.spyOn(store, "commsPins");
    try {
      const parsed = JSON.parse((await read({})).text) as {
        messages: { text: string; pinned: boolean }[];
      };
      expect(parsed.messages.map((m) => [m.text, m.pinned])).toEqual([
        ["mine", false],
        ["crew", false],
        ["pinned private", true],
        ["reply to mine", false],
      ]);
      // the pins are read once per call, not once per row
      expect(pins).toHaveBeenCalledTimes(1);
    } finally {
      pins.mockRestore();
    }
  });

  it("cuts each message's text at MC_TEXT_MAX with the stored-text marker", async () => {
    const long = "é".repeat(MC_TEXT_MAX + 5);
    store.addComms({ at: NOW - 1, from: "retro", to: "crew", ticket: null, text: long });
    const parsed = JSON.parse((await read({})).text) as { messages: { text: string }[] };
    expect(parsed.messages[0]?.text).toBe(
      `${"é".repeat(MC_TEXT_MAX)}${commsCutMarker(MC_TEXT_MAX, MC_TEXT_MAX + 5)}`,
    );
  });

  it("keeps the result under MC_COMMS_READ_MAX by leaving out the oldest messages, and says so", async () => {
    for (let n = 0; n < 30; n++)
      store.addComms({
        at: NOW - 100 + n,
        from: "retro",
        to: "crew",
        ticket: null,
        text: `${n} ${"x".repeat(MC_TEXT_MAX)}`,
      });
    const result = await read({ limit: 100 });
    expect(result.text.length).toBeLessThanOrEqual(MC_COMMS_READ_MAX);
    const parsed = JSON.parse(result.text) as {
      omitted: number;
      note: string;
      messages: { text: string }[];
    };
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(parsed.omitted + parsed.messages.length).toBe(30);
    expect(parsed.note).toBe(
      `${parsed.omitted} older messages were left out to keep this under ${MC_COMMS_READ_MAX} characters.`,
    );
    // the newest survive
    expect(parsed.messages.at(-1)?.text.startsWith("29 ")).toBe(true);
    expect(parsed.messages[0]?.text.startsWith(`${parsed.omitted} `)).toBe(true);
    // a small read has no note
    expect(JSON.parse((await read({ limit: 2 })).text)).not.toHaveProperty("omitted");
  });

  it("persists every supported destination, label, ref, reply and mention", async () => {
    liveSeat("guido-2", "guido-2:live");
    for (const [to, label, ref] of [
      ["guido-2", "question", "#703"],
      ["crew", "handoff", "PR 711"],
      ["CAPCOM", "blocker", undefined],
    ] as const)
      expect(await send({ to, text: `to ${to} @guido-2`, label, ref })).toMatchObject({
        text: expect.stringMatching(/^Sent comms:\d+\.$/),
      });
    const original = store.commsForPair("guido-1", "guido-2")[0];
    if (original === undefined) throw new Error("expected direct Comms row");
    expect(
      await send({ to: "guido-1", text: "reply", replyTo: original.id }, tools, {
        seatId: "guido-2",
        runId: "guido-2:live",
      }),
    ).toMatchObject({ text: expect.stringMatching(/^Sent comms:/) });
    expect(store.commsForAgent("guido-1")[0]).toMatchObject({
      label: "question",
      ref: "#703",
      mentions: ["guido-2"],
    });
    expect(store.commsForPair("guido-1", "guido-2").at(-1)).toMatchObject({
      replyTo: original.id,
      mentions: ["guido-1"],
    });
  });

  it.each([
    [{ to: "unknown", text: "x" }, "Unknown Comms destination."],
    [{ to: "guido-2", text: "x", label: "wrong" }, "Invalid arguments:"],
    [{ to: "guido-2", text: "x", ref: "703" }, "Invalid arguments:"],
    [
      { to: "guido-2", text: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "Refused: message contains",
    ],
  ])("refuses invalid destination, labels, refs and secrets: %o", async (args, expected) => {
    liveSeat("guido-2", "guido-2:live");
    const ts =
      (args as { text?: string }).text === "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ? make({ knownSecrets: async () => ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] })
        : tools;
    expect(await send(args, ts)).toMatchObject({
      text: expect.stringContaining(expected),
      isError: true,
    });
    expect(store.comms(0)).toEqual([]);
  });

  it("wakes labelled direct and mentioned seats once, while FYI and reactions do not", async () => {
    liveSeat("guido-2", "guido-2:live");
    const wake = vi.fn();
    const ts = make({ onComms: wake });
    await send({ to: "guido-2", text: "@guido-2 direct", label: "handoff" }, ts);
    const message = store.commsForAgent("guido-1")[0];
    if (message === undefined) throw new Error("expected Comms message");
    expect(wake).toHaveBeenCalledTimes(1);
    await send({ to: "guido-2", text: "FYI" }, ts);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await react({ id: message.id, reaction: "seen" }, ts)).toEqual({
      text: "Reaction recorded.",
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.comms(0)).toHaveLength(2);
    expect(store.commsReactions(message.id)).toHaveLength(1);
  });

  it.each([
    [{ id: "comms:1", reaction: "nope" }, "Invalid arguments:"],
    [{ id: "comms:1", reaction: "cant" }, "Invalid arguments:"],
    [{ id: "comms:1", reaction: "seen", reason: "why" }, "Invalid arguments:"],
    [{ id: "comms:99", reaction: "seen" }, "Unknown Comms message."],
  ])("refuses bad reactions: %o", async (args, expected) => {
    expect(await react(args)).toMatchObject({
      text: expect.stringContaining(expected),
      isError: true,
    });
  });

  it("refuses a live stored run whose seat was removed from the current crew", async () => {
    const message = store.addComms({
      at: NOW,
      from: "guido-2",
      to: "guido-1",
      ticket: null,
      text: "private",
    });
    if (message === null) throw new Error("Comms message was not stored");
    const removed = make({ crewIds: () => ["guido-2"] });
    expect(await react({ id: message.id, reaction: "seen" }, removed)).toEqual({
      text: "This seat is no longer in the crew.",
      isError: true,
    });
    expect(store.commsReactions(message.id)).toEqual([]);
  });

  it("refuses ended, inaccessible and rate-limited calls without changing their state", async () => {
    expect(await send({ to: "crew", text: "ended" }, tools, { ...CTX, runId: "gone" })).toEqual({
      text: "This run has ended.",
      isError: true,
    });
    liveSeat("guido-2", "guido-2:live");
    liveSeat("retro", "retro:live");
    await send({ to: "guido-2", text: "private" });
    const privateMessage = store.commsForPair("guido-1", "guido-2")[0];
    if (privateMessage === undefined) throw new Error("expected private message");
    expect(
      await react({ id: privateMessage.id, reaction: "seen" }, tools, {
        seatId: "retro",
        runId: "retro:live",
      }),
    ).toMatchObject({ text: "You cannot react to that Comms message.", isError: true });
    expect(
      await send({ to: "retro", text: "guess", replyTo: privateMessage.id }, tools, {
        seatId: "retro",
        runId: "retro:live",
      }),
    ).toMatchObject({ text: "You cannot reply to that Comms message.", isError: true });
    for (let i = 0; i < 29; i++) await send({ to: "crew", text: String(i) });
    expect(await send({ to: "crew", text: "one too many" })).toMatchObject({
      text: "Comms rate limit reached: 30 messages per 10 minutes.",
      isError: true,
    });
    expect(store.comms(0)).toHaveLength(30);
  });
});

describe("commit: what it refuses beyond areas (fix round 1)", () => {
  it("sees a nested repo that .gitmodules says to ignore, refuses it and leaves nothing staged", async () => {
    writeFileSync(
      join(wt, ".gitmodules"),
      '[submodule "docs/sub"]\n\tpath = docs/sub\n\turl = ./sub\n\tignore = all\n',
    );
    git(wt, "add", ".gitmodules");
    git(wt, "commit", "-qm", "modules");
    const base = head();
    nestedRepo("docs/sub");
    const r = await commit("feat: x");
    expect(r).toEqual({
      text: `Not committed: docs/sub is outside your area (apps/**).\n${REVERT}`,
      isError: true,
    });
    expect(staged()).toBe("");
    expect(git(wt, "ls-files", "-s", "docs/sub")).toBe("");
    // the next in-area commit carries only its own file
    write("apps/a.ts", "a2\n");
    rmSync(join(wt, "docs/sub"), { recursive: true, force: true });
    expect((await commit("feat: y")).text).toMatch(/^Committed /);
    expect(git(wt, "diff", "--name-only", base, "HEAD").trim()).toBe("apps/a.ts");
  });

  it("resets the index on Nothing to commit, too", async () => {
    write("apps/a.ts", "a2\n");
    const blind: McToolsDeps["git"] = async (cwd, args, common, o) =>
      args[0] === "diff" ? "" : crewGit(cwd, args, common, o);
    expect(await commit("feat: x", make({ git: blind }))).toEqual({ text: "Nothing to commit." });
    expect(staged()).toBe("");
  });

  it("resets the index when a step after the add throws", async () => {
    write("apps/a.ts", "a2\n");
    const broken: McToolsDeps["git"] = async (cwd, args, common, o) => {
      if (args[0] === "diff") throw new Error("diff broke");
      return crewGit(cwd, args, common, o);
    };
    await expect(commit("feat: x", make({ git: broken }))).rejects.toThrow("diff broke");
    expect(staged()).toBe("");
  });

  it("refuses a nested repository inside the area", async () => {
    const base = head();
    nestedRepo("apps/sub");
    expect(await commit("feat: x")).toEqual({
      text: `Not committed: apps/sub ${SPECIAL}\n${REVERT}`,
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
    expect(store.strays()).toEqual([]);
  });

  it("refuses symlinks inside the area, absolute or relative", async () => {
    const base = head();
    symlinkSync("/etc/passwd", join(wt, "apps/pw"));
    symlinkSync("../docs", join(wt, "apps/docslink"));
    write("apps/a.ts", "a2\n");
    expect((await commit("feat: x")).text).toBe(
      `Not committed: apps/docslink and apps/pw ${SPECIALS}\n${REVERT}`,
    );
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });

  it("refuses a file turned into a symlink", async () => {
    rmSync(join(wt, "apps/a.ts"));
    symlinkSync("/etc/hosts", join(wt, "apps/a.ts"));
    expect((await commit("feat: x")).text).toBe(`Not committed: apps/a.ts ${SPECIAL}\n${REVERT}`);
  });

  it("refuses a symlink named for a protected folder as protected", async () => {
    symlinkSync("evil", join(wt, "apps/.claude"));
    expect((await commit("feat: x")).text).toBe(
      `Not committed: apps/.claude is protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs it.\n${REVERT}`,
    );
  });

  it("matches protected files whatever their case (APFS)", async () => {
    write("apps/x/Package.json", "{}\n");
    write("apps/Vitest.config.ts", "x\n");
    expect((await commit("feat: x")).text).toBe(
      `Not committed: apps/Vitest.config.ts and apps/x/Package.json are protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs them.\n${REVERT}`,
    );
  });

  it("gives add and commit the slow timeout", async () => {
    write("apps/a.ts", "a2\n");
    const seen: [string, number | undefined][] = [];
    const spy: McToolsDeps["git"] = async (cwd, args, common, o) => {
      const sub = args.find((a) => a === "add" || a === "commit");
      if (sub !== undefined) seen.push([sub, o?.timeoutMs]);
      return crewGit(cwd, args, common, o);
    };
    await commit("feat: x", make({ git: spy }));
    expect(seen).toEqual([
      ["add", CREW_GIT_SLOW_MS],
      ["commit", CREW_GIT_SLOW_MS],
    ]);
  });

  it.each(["add", "commit"])(
    "answers a timed-out %s with a fixed text, index reset",
    async (sub) => {
      const base = head();
      write("apps/a.ts", "a2\n");
      // execFile kills a child at its timeout and rejects with `killed: true`; throwing that
      // here keeps the test independent of how fast git happens to be on the machine.
      const slow: McToolsDeps["git"] = async (cwd, args, common, o) => {
        if (args.includes(sub)) throw Object.assign(new Error("git timed out"), { killed: true });
        return crewGit(cwd, args, common, o);
      };
      expect(await commit("feat: x", make({ git: slow }))).toEqual({
        text: "Not committed: git took too long to stage or commit your changes, so the index was reset. Try again; if it keeps happening, tell FLIGHT with mc ask_flight.",
        isError: true,
      });
      expect(head()).toBe(base);
      expect(staged()).toBe("");
    },
  );

  it("checks the run again inside the clone's queue: a run that ended while queued commits nothing", async () => {
    write("apps/a.ts", "a2\n");
    write("docs/c.md", "c2\n");
    let ran = 0;
    const counting: McToolsDeps["git"] = async (cwd, args, common, o) => {
      ran++;
      return crewGit(cwd, args, common, o);
    };
    const ts = make({
      git: counting,
      inClone: async (_checkout, fn) => {
        // the run ends while the commit waits behind a slow checkout
        store.upsertRun(run({ endedAt: NOW, status: "ok" }));
        return fn();
      },
    });
    expect(await commit("feat: x", ts)).toEqual({ text: "This run has ended.", isError: true });
    expect(ran).toBe(0);
    expect(store.strays()).toEqual([]);
  });

  it("tells a read-only seat it cannot commit", async () => {
    liveSeat("retro", "retro:1");
    expect(await commit("feat: x", tools, { seatId: "retro", runId: "retro:1" })).toEqual({
      text: "Read-only roles cannot write: commit is for writer seats.",
      isError: true,
    });
  });
});

describe("commit: fix round 2", () => {
  const PROT_ONE =
    "is protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs it.";

  it("refuses any path that is not plain ASCII, wherever it is", async () => {
    const base = head();
    write("apps/x/package.jſon", "{}\n");
    write("apps/viteﬆ.config.ts", "x\n");
    write("apps/ok.ts", "ok\n");
    const r = await commit("feat: x");
    expect(r).toEqual({
      text: `Not committed: apps/viteﬆ.config.ts and apps/x/package.jſon are not plain ASCII paths; the crew commits ASCII paths only.\n${REVERT}`,
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });

  it("refuses a rename to a non-ASCII name, and a non-ASCII path outside the area without a stray", async () => {
    renameSync(join(wt, "apps/a.ts"), join(wt, "apps/ä.ts"));
    expect((await commit("feat: x")).text).toBe(
      `Not committed: apps/ä.ts is not plain ASCII paths; the crew commits ASCII paths only.\n${REVERT}`,
    );
    renameSync(join(wt, "apps/ä.ts"), join(wt, "apps/a.ts"));
    write(".huſky/pre-commit", "x\n");
    expect((await commit("feat: x")).text).toBe(
      `Not committed: .huſky/pre-commit is not plain ASCII paths; the crew commits ASCII paths only.\n${REVERT}`,
    );
    expect(store.strays()).toEqual([]);
  });

  it("protects .gitmodules", async () => {
    write(".gitmodules", '[submodule "apps/sub"]\n\tpath = apps/sub\n\turl = ./sub\n');
    expect((await commit("feat: x")).text).toBe(
      `Not committed: .gitmodules ${PROT_ONE}\n${REVERT}`,
    );
  });

  it("names ten symlinks, then and {n} more", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `apps/l${String(i + 1).padStart(2, "0")}`);
    for (const n of names) symlinkSync("a.ts", join(wt, n));
    expect((await commit("feat: x")).text).toBe(
      `Not committed: ${names.slice(0, 10).join(", ")} and 2 more ${SPECIALS}\n${REVERT}`,
    );
  });

  it("orders a mixed answer: other-area, link, protected", async () => {
    write("web/b.ts", "b2\n");
    symlinkSync("a.ts", join(wt, "apps/link"));
    write("apps/package.json", "{}\n");
    expect((await commit("feat: x")).text).toBe(
      [
        "Not committed: web/b.ts is in GUIDO-2's area.",
        `Not committed: apps/link ${SPECIAL}`,
        `Not committed: apps/package.json ${PROT_ONE}`,
        REVERT,
      ].join("\n"),
    );
  });

  it("refuses an in-area nested repo that .gitmodules says to ignore", async () => {
    writeFileSync(
      join(wt, ".gitmodules"),
      '[submodule "apps/sub"]\n\tpath = apps/sub\n\turl = ./sub\n\tignore = all\n',
    );
    git(wt, "add", ".gitmodules");
    git(wt, "commit", "-qm", "modules");
    nestedRepo("apps/sub");
    expect(await commit("feat: x")).toEqual({
      text: `Not committed: apps/sub ${SPECIAL}\n${REVERT}`,
      isError: true,
    });
    expect(staged()).toBe("");
  });

  it("refuses files put in a former submodule's folder, rather than answer Nothing to commit", async () => {
    const blob = git(wt, "rev-parse", "HEAD").trim();
    git(wt, "update-index", "--add", "--cacheinfo", `160000,${blob},apps/sub`);
    git(wt, "commit", "-qm", "gitlink");
    const base = head();
    write("apps/sub/x.ts", "x\n");
    expect(await commit("feat: x")).toEqual({
      text: `Not committed: apps/sub is a former submodule folder; the files in it cannot be committed here (this check covers the whole repository, not only your paths).\n${REVERT}`,
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
    // an empty folder there is the ordinary unchecked-out submodule: nothing to say
    rmSync(join(wt, "apps/sub/x.ts"));
    expect(await commit("feat: x")).toEqual({ text: "Nothing to commit." });
  });

  it("gives the staged-paths diff the slow timeout, and answers an overflow with a fixed text", async () => {
    write("apps/a.ts", "a2\n");
    const seen: (number | undefined)[] = [];
    const caps: (number | undefined)[] = [];
    const spy: McToolsDeps["git"] = async (cwd, args, common, o) => {
      if (args[0] === "diff") seen.push(o?.timeoutMs);
      if (args[0] === "diff") caps.push(o?.maxBuffer);
      return crewGit(cwd, args, common, o);
    };
    await commit("feat: x", make({ git: spy }));
    // the listing, then the secret scan's patch (with the push scan's 64 MiB cap)
    expect(seen).toEqual([CREW_GIT_SLOW_MS, CREW_GIT_SLOW_MS]);
    expect(caps).toEqual([undefined, 64 * 1024 * 1024]);

    // the scan's patch passing its cap answers the same way
    write("apps/a.ts", "a2b\n");
    const before = head();
    const tinyScan: McToolsDeps["git"] = async (cwd, args, common, o) =>
      crewGit(cwd, args, common, args.includes("--text") ? { ...o, maxBuffer: 10 } : o);
    expect((await commit("feat: x", make({ git: tinyScan }))).text).toMatch(
      /^Not committed: the change is too large for the commit tool to check/,
    );
    expect(head()).toBe(before);
    expect(staged()).toBe("");

    write("apps/a.ts", "a3\n");
    const base = head();
    const tiny: McToolsDeps["git"] = async (cwd, args, common, o) =>
      crewGit(cwd, args, common, args[0] === "diff" ? { ...o, maxBuffer: 10 } : o);
    expect(await commit("feat: x", make({ git: tiny }))).toEqual({
      text: "Not committed: the change is too large for the commit tool to check, so the index was reset. Commit fewer files at once; if it keeps happening, tell FLIGHT with mc ask_flight.",
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });

  it("a commit that timed out after HEAD moved is recorded and answered as committed", async () => {
    write("apps/a.ts", "a2\n");
    const late: McToolsDeps["git"] = async (cwd, args, common, o) => {
      const out = await crewGit(cwd, args, common, o);
      if (args.includes("commit")) throw Object.assign(new Error("timed out"), { killed: true });
      return out;
    };
    const r = await commit("feat: late", make({ git: late }));
    const sha = head();
    expect(r).toEqual({ text: `Committed ${sha.slice(0, 7)} on ${BRANCH}: feat: late` });
    expect(store.runCommits(RUN)).toEqual([sha]);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });
});

describe("commit: fix round 3", () => {
  it.each([
    ["a tab", "apps/a\tb.ts"],
    ["an ESC byte", "apps/\u001b[31mred.ts"],
    ["a DEL byte", "apps/del\u007f.ts"],
  ])("refuses a path holding %s as not plain ASCII", async (_what, path) => {
    const base = head();
    write(path, "x\n");
    expect(await commit("feat: x")).toEqual({
      text: `Not committed: ${path} is not plain ASCII paths; the crew commits ASCII paths only.\n${REVERT}`,
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });

  it("lists the index with its own 64 MiB cap, and answers an overflow with its own text", async () => {
    write("apps/a.ts", "a2\n");
    const caps: (number | undefined)[] = [];
    const spy: McToolsDeps["git"] = async (cwd, args, common, o) => {
      if (args[0] === "ls-files") caps.push(o?.maxBuffer);
      return crewGit(cwd, args, common, o);
    };
    await commit("feat: x", make({ git: spy }));
    expect(caps).toEqual([64 * 1024 * 1024]);

    write("apps/a.ts", "a3\n");
    const base = head();
    const tiny: McToolsDeps["git"] = async (cwd, args, common, o) =>
      crewGit(cwd, args, common, args[0] === "ls-files" ? { ...o, maxBuffer: 10 } : o);
    expect(await commit("feat: x", make({ git: tiny }))).toEqual({
      text: "Not committed: the commit tool could not list the index; ask FLIGHT with mc ask_flight.",
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });
});

// ---------- Task 9: push and draft_pr ----------

/** A GitHub-shaped token (the pattern scan) and a local credential (the verbatim scan). */
const TOKEN = `ghp_${"A1b2".repeat(9)}`;
const LOCAL = "mc-local-credential-0123456789";
const PR_URL = "https://github.com/o/mc/pull/7";
const GH_ENV_KEYS = ["GH_PROMPT_DISABLED", "HOME", "PATH"];

/** A fake gh: answers from state.json by its first two words, and records each call. */
const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
const call = { args, cwd: process.cwd(), env: process.env };
const bodyArg = args.find((a) => a.startsWith("--body-file="));
if (bodyArg) {
  const f = bodyArg.slice("--body-file=".length);
  call.bodyFile = f;
  call.body = fs.readFileSync(f, "utf8");
  call.mode = (fs.statSync(f).mode & 0o777).toString(8);
}
fs.appendFileSync(path.join(here, "calls.jsonl"), JSON.stringify(call) + "\\n");
const state = JSON.parse(fs.readFileSync(path.join(here, "state.json"), "utf8"));
const key = args.slice(0, 2).join(" ");
const r = state[key] || { code: 0, stdout: "" };
if (r.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleepMs);
const created = path.join(here, "created");
if (key === "pr create" && r.marksOpen) fs.writeFileSync(created, (r.stdout || "").trim());
if (key === "pr list" && fs.existsSync(created)) {
  r.stdout = JSON.stringify([{ url: fs.readFileSync(created, "utf8") }]);
}
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.code || 0);
`;

describe("commit: secrets (final review m6)", () => {
  const SECRET_TAIL = "Take it out, then commit again.";

  it("refuses a staged token before any commit exists: file, line and kind, never the token", async () => {
    const base = head();
    write("apps/a.ts", `const a = 1;\nconst t = "${TOKEN}";\n`);
    const r = await commit("feat: x");
    expect(r).toEqual({
      text: `Not committed: apps/a.ts:2 looks like a GitHub token. ${SECRET_TAIL}`,
      isError: true,
    });
    expect(r.text).not.toContain(TOKEN);
    // as the other refusals leave them: no commit, nothing staged, the seat's file untouched
    expect(head()).toBe(base);
    expect(store.runCommits(RUN)).toEqual([]);
    expect(staged()).toBe("");
    expect(readFileSync(join(wt, "apps", "a.ts"), "utf8")).toContain(TOKEN);
    expect(store.guardHits(0).map((h) => [h.agentId, h.runId, h.rule, h.text])).toEqual([
      ["guido-1", RUN, "secret", "No secrets in a push: mc commit"],
    ]);
    expect(emitted).toContain("guard");
    // the seat takes it out and commits
    write("apps/a.ts", "const a = 1;\n");
    expect((await commit("feat: x")).text).toMatch(/^Committed /);
  });

  it("refuses a token in the message, by its line", async () => {
    const base = head();
    write("apps/a.ts", "a2\n");
    expect(await commit(`feat: x\n\nkey ${TOKEN}`)).toEqual({
      text: `Not committed: commit message:3 looks like a GitHub token. ${SECRET_TAIL}`,
      isError: true,
    });
    expect(head()).toBe(base);
    expect(staged()).toBe("");
  });

  it("reads a staged rename as the whole file added (--no-renames)", async () => {
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(clone, "remote", "add", "origin", origin);
    git(clone, "checkout", "-q", "main");
    writeFileSync(join(clone, "apps", "old.ts"), `${LOCAL}\n`);
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "fixture");
    git(clone, "push", "-q", "origin", "main");
    git(wt, "merge", "-q", "--ff-only", "main");
    git(clone, "config", "diff.renames", "true");
    renameSync(join(wt, "apps", "old.ts"), join(wt, "apps", "new.ts"));
    expect(await commit("refactor: move", make({ knownSecrets: async () => [LOCAL] }))).toEqual({
      text: `Not committed: apps/new.ts:1 looks like a local credential. ${SECRET_TAIL}`,
      isError: true,
    });
  });

  it("reads staged files as stored, not through a textconv driver (--no-textconv)", async () => {
    writeFileSync(join(clone, ".git", "info", "attributes"), "*.dat diff=hide\n");
    git(clone, "config", "diff.hide.textconv", "true");
    write("apps/k.dat", `${TOKEN}\n`);
    expect(await commit("feat: x")).toEqual({
      text: `Not committed: apps/k.dat:1 looks like a GitHub token. ${SECRET_TAIL}`,
      isError: true,
    });
  });

  it("refuses a known secret verbatim, and a file under * -diff read as stored", async () => {
    writeFileSync(join(clone, ".git", "info", "attributes"), "* -diff\n");
    write("apps/blob.dat", `bin\n${LOCAL}\n`);
    expect(await commit("feat: x", make({ knownSecrets: async () => [LOCAL] }))).toEqual({
      text: `Not committed: apps/blob.dat:2 looks like a local credential. ${SECRET_TAIL}`,
      isError: true,
    });
    expect(staged()).toBe("");
  });
});

interface GhCall {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  body?: string;
  bodyFile?: string;
  mode?: string;
}

describe("push and draft_pr", () => {
  let origin: string;
  let ghDir: string;
  let known: string[];

  const ghState = (
    state: Record<
      string,
      { code?: number; stdout?: string; stderr?: string; sleepMs?: number; marksOpen?: boolean }
    >,
  ) => writeFileSync(join(ghDir, "state.json"), JSON.stringify(state));
  const ghCalls = (): GhCall[] => {
    try {
      return readFileSync(join(ghDir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as GhCall);
    } catch {
      return [];
    }
  };
  const pushDeps = (over: Partial<McToolsDeps> = {}) =>
    deps({ gh: createGh(join(ghDir, "gh")), knownSecrets: async () => known, ...over });
  // the MCP server no longer serves push or draft_pr (the engine calls the two functions), so the
  // suite reaches them through tools it builds itself, which only pass the run on
  const ts = (over: Partial<McToolsDeps> = {}): McTool[] => {
    const d = pushDeps(over);
    const direct = (name: string, call: McTool["call"]): McTool => ({
      name,
      description: "",
      inputSchema: { type: "object" },
      modes: ["writer"],
      call,
    });
    return [
      ...createMcTools(d),
      direct("push", async (ctx) => pushRun(d, ctx.runId)),
      direct("draft_pr", async (ctx, args) =>
        openDraftPr(d, ctx.runId, args as { title: string; body: string }),
      ),
    ];
  };
  const push = (t: McTool[] = ts(), ctx: McToolContext = CTX) => tool("push", t).call(ctx, {});
  const pr = (title: string, body: string, t: McTool[] = ts(), ctx: McToolContext = CTX) =>
    tool("draft_pr", t).call(ctx, { title, body });
  const remoteTip = (branch = BRANCH): string | null => {
    try {
      return git(origin, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).trim();
    } catch {
      return null;
    }
  };
  const commitOk = async (rel: string, text: string, message = `feat: ${rel}`, ctx = CTX) => {
    write(rel, text);
    const r = await tool("commit", ts()).call(ctx, { message });
    expect(r.text).toMatch(/^Committed /);
    return head();
  };
  it("pushes a removal commit", async () => {
    const r = await rm(["apps/a.ts"], "chore: drop a", ts());
    expect(r.text).toMatch(/^Removed apps\/a\.ts\.\nCommitted /);
    expect((await push()).text).toBe(`Pushed ${head().slice(0, 7)} to ${BRANCH}.`);
    expect(git(origin, "ls-tree", "-r", "--name-only", BRANCH)).not.toContain("apps/a.ts");
  });

  /**
   * A commit the hub recorded whose message the commit tool would now refuse (one made before its
   * check existed): the push's message check is the backstop for it.
   */
  const hubRecorded = (message: string) => {
    write("apps/a.ts", `${message.length}\n`);
    git(wt, "commit", "-qam", message);
    const sha = head();
    store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha, at: NOW });
    return sha;
  };
  /**
   * A recorded commit holding a secret the commit tool would now refuse (one made before its scan
   * existed, or with a known secret it could not read in time): the push's scan is the backstop.
   */
  const recordedWithSecret = (rel: string, text: string, message = `feat: ${rel}`) => {
    write(rel, text);
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", message);
    const sha = head();
    store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha, at: NOW });
    return sha;
  };
  /** Another clone of origin, as the operator's machine: commits there reach origin with raw git. */
  const operatorPushes = (file: string, branch = BRANCH) => {
    const other = join(dir, `operator-${Math.random().toString(36).slice(2)}`);
    git(dir, "clone", "-q", origin, other);
    git(other, "checkout", "-q", branch);
    writeFileSync(join(other, file), "operator\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "the operator's change");
    git(other, "push", "-q", "origin", branch);
    return git(other, "rev-parse", "HEAD").trim();
  };
  /** A later run of the same seat on the same ticket (the earlier one ended). */
  const nextRun = (id: string) => {
    store.upsertRun(run({ endedAt: NOW, status: "ok" }));
    store.upsertRun(run({ id, seq: 2 }));
    const row = store.seatSession("guido-1");
    if (row === null) throw new Error("no seat row");
    store.setSeatSession({ ...row, runId: id });
    return { seatId: "guido-1", runId: id };
  };
  /** Records the stdout of each git subcommand named in `subs`. */
  const recording =
    (subs: string[], seen: Record<string, string[]>): McToolsDeps["git"] =>
    async (cwd, args, common, o) => {
      const out = await crewGit(cwd, args, common, o);
      const sub = args.find((a) => subs.includes(a));
      if (sub !== undefined) seen[sub] = [...(seen[sub] ?? []), out];
      return out;
    };
  const noSecretAnywhere = (answers: string[]) => {
    const everything = [
      ...logs,
      ...answers,
      ...store.guardHits(0).map((h) => h.text),
      ...store.crewErrors().map((e) => e.text),
      ...store.openQuestions().map((q) => q.text),
    ].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(LOCAL);
  };

  beforeEach(() => {
    origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(clone, "remote", "add", "origin", origin);
    git(clone, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    ghDir = join(dir, "fakegh");
    mkdirSync(ghDir);
    writeFileSync(join(ghDir, "gh"), FAKE_GH, { mode: 0o755 });
    ghState({ "pr list": { stdout: "[]\n" }, "pr create": { stdout: `${PR_URL}\n` } });
    known = [LOCAL];
  });

  describe("push", () => {
    it("pushes the run's hub-made commits as a plain fast-forward and records the push", async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      const pushes: string[][] = [];
      const spy: McToolsDeps["git"] = async (cwd, args, common, o) => {
        if (args.includes("push")) pushes.push(args);
        return crewGit(cwd, args, common, o);
      };
      expect(await push(ts({ git: spy }))).toEqual({
        text: `Pushed ${sha.slice(0, 7)} to ${BRANCH}.`,
      });
      expect(remoteTip()).toBe(sha);
      expect(store.runPush(RUN)).toEqual({ sha, at: NOW });
      // never forced: no +, no --force, no lease, no tags
      expect(pushes).toEqual([
        [
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--no-recurse-submodules",
          "origin",
          `${sha}:refs/heads/${BRANCH}`,
        ],
      ]);
      expect(remoteTip("main")).toBe(git(clone, "rev-parse", "main").trim());
    });

    it("refuses a push to a branch whose PR merged or closed, naming the PR, and sends nothing", async () => {
      await commitOk("apps/a.ts", "a2\n");
      store.setRunLoop(RUN, { ...NEW_LOOP, prNumber: 727 });
      for (const [state, word] of [
        ["MERGED", "merged"],
        ["CLOSED", "closed"],
      ] as const) {
        ghState({ "pr view": { stdout: `${JSON.stringify({ state })}\n` } });
        const text = pushPrDoneText(BRANCH, 727, word);
        expect(await push()).toEqual({ text, isError: true });
        expect(text).toContain("PR #727");
        expect(remoteTip()).toBeNull();
        expect(store.runPush(RUN)).toBeNull();
      }
    });

    it("refuses a push when the run has no PR yet but the branch's last PR merged", async () => {
      await commitOk("apps/a.ts", "a2\n");
      store.setRunLoop(RUN, { ...NEW_LOOP, prNumber: null });
      store.upsertPullRequests(
        "mc",
        [
          {
            repoId: "mc",
            number: 727,
            headSha: "a",
            title: "x",
            url: "https://github.com/o/mc/pull/727",
            branch: BRANCH,
            ticket: "mc#42",
            state: "merged",
            isDraft: false,
            review: null,
            ci: null,
            createdAt: NOW - 86_400_000,
            updatedAt: NOW - 3_600_000,
            mergedAt: NOW - 3_600_000,
            mergeable: null,
          },
        ],
        NOW,
      );
      expect(await push()).toEqual({ text: pushPrDoneText(BRANCH, 727, "merged"), isError: true });
      expect(remoteTip()).toBeNull();
    });

    it("pushes while the run's PR is open, and refuses when gh cannot say", async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      store.setRunLoop(RUN, { ...NEW_LOOP, prNumber: 727 });
      ghState({ "pr view": { code: 1, stderr: "HTTP 502\n" } });
      expect(await push()).toEqual({ text: MC_PUSH_FAILED, isError: true });
      ghState({ "pr view": { stdout: `${JSON.stringify({ state: "OPEN" })}\n` } });
      expect((await push()).text).toBe(`Pushed ${sha.slice(0, 7)} to ${BRANCH}.`);
    });

    it("gives every slow step the slow timeout and runs in the clone's queue", async () => {
      await commitOk("apps/a.ts", "a2\n");
      const seen: [string, number | undefined][] = [];
      const queued: string[] = [];
      const spy: McToolsDeps["git"] = async (cwd, args, common, o) => {
        const sub = args.find((a) => ["ls-remote", "fsck", "log", "push"].includes(a));
        if (sub !== undefined) seen.push([sub, o?.timeoutMs]);
        return crewGit(cwd, args, common, o);
      };
      await push(
        ts({
          git: spy,
          inClone: async (checkout, fn) => {
            queued.push(checkout);
            return fn();
          },
        }),
      );
      expect(queued).toEqual([clone]);
      expect(new Set(seen.map(([sub]) => sub))).toEqual(
        new Set(["ls-remote", "fsck", "log", "push"]),
      );
      for (const [, ms] of seen) expect(ms).toBe(CREW_GIT_SLOW_MS);
    });

    it("answers Nothing to push for a branch with no new commits", async () => {
      expect(await push()).toEqual({ text: "Nothing to push." });
      expect(remoteTip()).toBeNull();
      expect(store.runPush(RUN)).toBeNull();
    });

    it("answers Already on origin, and records it, when origin is at the tip (a push cut off and retried)", async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      // the push lands, then git is killed before it answers
      const cut: McToolsDeps["git"] = async (cwd, args, common, o) => {
        const out = await crewGit(cwd, args, common, o);
        if (args.includes("push")) throw Object.assign(new Error("timed out"), { killed: true });
        return out;
      };
      const first = await push(ts({ git: cut }));
      expect(first).toEqual({
        text: "Not pushed: git could not push to origin. Check the connection and your GitHub access, then message the seat to try again.",
        isError: true,
      });
      expect(remoteTip()).toBe(sha);
      expect(store.runPush(RUN)).toBeNull();
      expect(await push()).toEqual({ text: `Already on origin: ${sha.slice(0, 7)}.` });
      expect(store.runPush(RUN)).toEqual({ sha, at: NOW });
      // and again, with nothing new
      expect(await push()).toEqual({ text: `Already on origin: ${sha.slice(0, 7)}.` });
    });

    it("refuses when origin's branch moved, and never overwrites it", async () => {
      await commitOk("apps/a.ts", "a2\n");
      await push();
      const theirs = operatorPushes("docs/operator.md");
      await commitOk("apps/a.ts", "a3\n");
      expect(await push()).toEqual({
        text: originMovedText(BRANCH),
        isError: true,
      });
      expect(remoteTip()).toBe(theirs);
    });

    it("answers git's own non-fast-forward refusal (origin moved after the check) with the same text", async () => {
      await commitOk("apps/a.ts", "a2\n");
      await push();
      await commitOk("apps/a.ts", "a3\n");
      let theirs = "";
      const race: McToolsDeps["git"] = async (cwd, args, common, o) => {
        if (args.includes("push")) theirs = operatorPushes("docs/race.md");
        return crewGit(cwd, args, common, o);
      };
      expect(await push(ts({ git: race }))).toEqual({
        text: originMovedText(BRANCH),
        isError: true,
      });
      expect(remoteTip()).toBe(theirs);
    });

    it("refuses a commit made with raw git in the clone (a bypass of the commit tool), naming it for the operator and raising no item of its own", async () => {
      write("apps/a.ts", "raw\n");
      git(wt, "commit", "-qam", "raw commit");
      const raw = head();
      emitted = [];
      expect(await push()).toEqual({ text: FOREIGN(raw), isError: true });
      expect(remoteTip()).toBeNull();
      expect(store.crewErrors()).toEqual([]);
      expect(emitted).not.toContain("attention");
    });

    it("refuses a branch whose tip is not the last commit the hub recorded", async () => {
      await commitOk("apps/a.ts", "a2\n");
      write("apps/a.ts", "on top\n");
      git(wt, "commit", "-qam", "on top");
      expect((await push()).text).toBe(FOREIGN(head()));
      expect(remoteTip()).toBeNull();
    });

    it("refuses a merge commit", async () => {
      operatorPushes("docs/main.md", "main");
      git(clone, "fetch", "-q", "origin");
      git(wt, "merge", "-q", "--no-ff", "-m", "merge main", "origin/main");
      expect(await push()).toEqual({
        text: MC_PUSH_MERGE,
        isError: true,
      });
      expect(remoteTip()).toBeNull();
    });

    describe("the configured checks", () => {
      const LINT = "pnpm -s lint";
      const TYPES = "pnpm -s typecheck";
      const gated = (over: Partial<McToolsDeps> = {}) =>
        ts({ checks: async () => [LINT, TYPES], ...over });
      const ran = (command: string, headSha: string, ok: boolean, at = NOW) =>
        store.addCheckRun({ runId: RUN, command, headSha, ok, at });
      const refusal = (
        head: string,
        found: {
          command: string;
          state: "missing" | "failed";
          recorded?: {
            headSha: string;
            invokedCommand: string;
            ok: boolean;
            exitCode: number | null;
            at: number;
          } | null;
          dropped?: CheckDrop | null;
        }[],
      ) => ({
        text: pushChecksText(head, found),
        isError: true,
      });

      it("pushes a head on which every configured check passed", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, true);
        ran(TYPES, sha, true);
        expect(await push(gated())).toEqual({ text: `Pushed ${sha.slice(0, 7)} to ${BRANCH}.` });
        expect(remoteTip()).toBe(sha);
      });

      it("refuses a check that was never run, naming it and its command", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, true);
        const r = await push(gated());
        expect(r).toEqual(refusal(sha, [{ command: TYPES, state: "missing" }]));
        expect(r.text).toContain(MC_PUSH_CHECKS);
        expect(r.text).toContain(`not run: ${TYPES}`);
        expect(remoteTip()).toBeNull();
      });

      it.each([
        ["not-plain", "chains the check with a pipe"],
        ["dirty-start", "uncommitted or untracked files in the tree"],
        ["dirty-end", "left uncommitted or untracked files"],
        ["head-moved", "moved the head during the call"],
        ["turn-ended", "the turn ended before the call reported its end"],
        ["background", "went to the background"],
        ["timeout", "Bash timeout"],
        ["unreadable", "could not read the seat's clone"],
      ] as const)("says why a %s call was not counted, in the refusal", async (reason, words) => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, true);
        const drop = { reason, command: TYPES, head: sha, invoked: TYPES, at: NOW };
        const r = await push(gated({ checkDrops: () => [drop] }));
        expect(r).toEqual(refusal(sha, [{ command: TYPES, state: "missing", dropped: drop }]));
        expect(r.text).toContain(words);
        expect(r.text).not.toContain("nothing recorded");
      });

      it("says the hub saw no start when it has no reason for a missing check", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, true);
        const r = await push(gated({ checkDrops: () => [] }));
        expect(r.text).toContain(`nothing recorded on ${sha.slice(0, 7)}: the hub saw no start`);
        expect(r.text).toContain("Bash timeout parameter set to 600000");
      });

      it("refuses a check that failed, naming it", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, false);
        ran(TYPES, sha, true);
        const r = await push(gated());
        expect(r).toEqual(
          refusal(sha, [
            {
              command: LINT,
              state: "failed",
              recorded: { headSha: sha, invokedCommand: LINT, ok: false, exitCode: null, at: NOW },
            },
          ]),
        );
        expect(r.text).toContain(`failed: ${LINT}`);
        expect(remoteTip()).toBeNull();
      });

      it("takes the newest run: a pass after a failure passes, a failure after a pass refuses", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, false, NOW);
        ran(LINT, sha, true, NOW + 1);
        ran(TYPES, sha, true, NOW);
        ran(TYPES, sha, false, NOW + 1);
        expect(await push(gated())).toEqual(
          refusal(sha, [
            {
              command: TYPES,
              state: "failed",
              recorded: {
                headSha: sha,
                invokedCommand: TYPES,
                ok: false,
                exitCode: null,
                at: NOW + 1,
              },
            },
          ]),
        );
      });

      it("refuses checks that passed on an older head, and lists every missing one", async () => {
        const old = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, old, true);
        ran(TYPES, old, true);
        const sha = await commitOk("apps/a.ts", "a3\n");
        expect(await push(gated())).toEqual(
          refusal(sha, [
            {
              command: LINT,
              state: "missing",
              recorded: { headSha: old, invokedCommand: LINT, ok: true, exitCode: null, at: NOW },
            },
            {
              command: TYPES,
              state: "missing",
              recorded: { headSha: old, invokedCommand: TYPES, ok: true, exitCode: null, at: NOW },
            },
          ]),
        );
        expect(remoteTip()).toBeNull();
      });

      it("names the latest recorded command, exit and commit when that record is not on the head", async () => {
        const old = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, old, true, NOW);
        const sha = await commitOk("apps/a.ts", "a3\n");
        const r = await push(gated());
        expect(r.isError).toBe(true);
        expect(r.text).toContain(
          `not run: ${LINT}\n  recorded: ${LINT} exited unknown on ${old.slice(0, 7)}`,
        );
        expect(r.text).toContain(`not run: ${TYPES}\n  nothing recorded`);
        expect(r.text).toContain(`Commit ${sha.slice(0, 7)}`);
      });

      it("names a chained invocation and its numeric exit", async () => {
        const old = await commitOk("apps/a.ts", "a2\n");
        store.addCheckRun({
          runId: RUN,
          command: LINT,
          invokedCommand: `${LINT} && ${TYPES}`,
          headSha: old,
          ok: false,
          exitCode: 2,
          at: NOW,
        });
        const sha = await commitOk("apps/a.ts", "a3\n");
        const r = await push(gated());
        expect(r.text).toContain(`recorded: ${LINT} && ${TYPES} exited 2 on ${old.slice(0, 7)}`);
        expect(r.text).toContain(`Commit ${sha.slice(0, 7)}`);
      });

      it("names a chained invocation and its numeric exit on the rejected head", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        store.addCheckRun({
          runId: RUN,
          command: LINT,
          invokedCommand: `${LINT} && ${TYPES}`,
          headSha: sha,
          ok: false,
          exitCode: 2,
          at: NOW,
        });
        const r = await push(gated());
        expect(r.text).toContain(`recorded: ${LINT} && ${TYPES} exited 2 on ${sha.slice(0, 7)}`);
      });

      it("ignores another run's records", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        store.addCheckRun({ runId: "other", command: LINT, headSha: sha, ok: true, at: NOW });
        store.addCheckRun({ runId: "other", command: TYPES, headSha: sha, ok: true, at: NOW });
        expect((await push(gated())).isError).toBe(true);
      });

      const asAuthor = (name: string) => ({
        GIT_AUTHOR_NAME: name,
        GIT_COMMITTER_NAME: name,
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_EMAIL: "t@example.com",
      });
      /**
       * The branch's own commit (pushed first, its checks passed, unless `pushed` is false), then
       * main merged in by `author` with `subject` (a clean merge).
       */
      const branchThenMerge = async (
        author: string,
        subject: string,
        pushed = true,
      ): Promise<string> => {
        write("apps/a.ts", "branch\n");
        git(wt, "commit", "-qam", "feat: branch");
        const own = head();
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: own, at: NOW });
        if (pushed) {
          ran(LINT, own, true);
          ran(TYPES, own, true);
          expect((await push(gated())).text).toBe(`Pushed ${own.slice(0, 7)} to ${BRANCH}.`);
        }
        operatorPushes("docs/main.md", "main");
        git(clone, "fetch", "-q", "origin");
        execFileSync("git", ["merge", "--no-ff", "-q", "-m", subject, "origin/main"], {
          cwd: wt,
          env: { ...process.env, ...asAuthor(author) },
        });
        const merge = head();
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: merge, at: NOW });
        return merge;
      };

      it("does not gate the engine's merge of main, but gates a commit on top of it", async () => {
        const merge = await branchThenMerge(MC_MERGE_AUTHOR, `Merge main into ${BRANCH}`);
        const own = git(wt, "rev-parse", `${merge}^1`).trim();
        expect((await push(gated())).text).toBe(`Pushed ${merge.slice(0, 7)} to ${BRANCH}.`);
        const next = await commitOk("apps/a.ts", "on top\n");
        expect(await push(gated())).toEqual(
          refusal(next, [
            {
              command: LINT,
              state: "missing",
              recorded: { headSha: own, invokedCommand: LINT, ok: true, exitCode: null, at: NOW },
            },
            {
              command: TYPES,
              state: "missing",
              recorded: { headSha: own, invokedCommand: TYPES, ok: true, exitCode: null, at: NOW },
            },
          ]),
        );
      });

      it("gates a merge whose first parent was never pushed, even under the engine's name", async () => {
        const merge = await branchThenMerge(MC_MERGE_AUTHOR, `Merge main into ${BRANCH}`, false);
        expect(await push(gated())).toEqual(
          refusal(merge, [
            { command: LINT, state: "missing" },
            { command: TYPES, state: "missing" },
          ]),
        );
        expect(remoteTip()).toBeNull();
      });

      it("gates a merge when the seat's unpushed commit sits under it, after an earlier push", async () => {
        const first = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, first, true);
        ran(TYPES, first, true);
        await push(gated());
        const merge = await branchThenMerge(MC_MERGE_AUTHOR, `Merge main into ${BRANCH}`, false);
        expect((await push(gated())).text).toBe(
          pushChecksText(merge, [
            {
              command: LINT,
              state: "missing",
              recorded: { headSha: first, invokedCommand: LINT, ok: true, exitCode: null, at: NOW },
            },
            {
              command: TYPES,
              state: "missing",
              recorded: {
                headSha: first,
                invokedCommand: TYPES,
                ok: true,
                exitCode: null,
                at: NOW,
              },
            },
          ]),
        );
      });

      it("gates a seat's own merge of main", async () => {
        const merge = await branchThenMerge("Seat", `Merge main into ${BRANCH}`);
        const own = git(wt, "rev-parse", `${merge}^1`).trim();
        expect(await push(gated())).toEqual(
          refusal(merge, [
            {
              command: LINT,
              state: "missing",
              recorded: { headSha: own, invokedCommand: LINT, ok: true, exitCode: null, at: NOW },
            },
            {
              command: TYPES,
              state: "missing",
              recorded: { headSha: own, invokedCommand: TYPES, ok: true, exitCode: null, at: NOW },
            },
          ]),
        );
      });

      it("gates a merge of main under the engine's name whose tree carries an edit", async () => {
        const merge = await branchThenMerge(MC_MERGE_AUTHOR, `Merge main into ${BRANCH}`);
        write("apps/a.ts", "rides along\n");
        git(wt, "add", "-A");
        execFileSync("git", ["commit", "-q", "--amend", "--no-edit"], {
          cwd: wt,
          env: { ...process.env, ...asAuthor(MC_MERGE_AUTHOR) },
        });
        const amended = head();
        expect(amended).not.toBe(merge);
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: amended, at: NOW });
        expect((await push(gated())).isError).toBe(true);
      });

      it("fails the push, never ungates it, when the checks cannot be read", async () => {
        await commitOk("apps/a.ts", "a2\n");
        const r = await push(
          ts({
            checks: async () => {
              throw new Error("rules unreadable");
            },
          }),
        );
        expect(r).toEqual({ text: MC_PUSH_FAILED, isError: true });
      });

      it("does not gate a repo that configures no checks", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        expect(await push(ts({ checks: async () => [] }))).toEqual({
          text: `Pushed ${sha.slice(0, 7)} to ${BRANCH}.`,
        });
      });

      it("answers Already on origin without asking for checks", async () => {
        const sha = await commitOk("apps/a.ts", "a2\n");
        ran(LINT, sha, true);
        ran(TYPES, sha, true);
        await push(gated());
        expect(await push(gated())).toEqual({ text: `Already on origin: ${sha.slice(0, 7)}.` });
      });
    });

    describe("a merge of main", () => {
      /** The branch edits apps/a.ts; main (origin) edits `mainFile`; the merge is left uncommitted. */
      const mergeMain = (mainFile: string): void => {
        write("apps/a.ts", "branch\n");
        git(wt, "commit", "-qam", "feat: branch");
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: head(), at: NOW });
        operatorPushes(mainFile, "main");
        git(clone, "fetch", "-q", "origin");
        try {
          git(wt, "merge", "--no-ff", "--no-commit", "origin/main");
        } catch {
          // a conflict: the resolution is the test's
        }
      };
      const concludeMerge = (): string => {
        git(wt, "add", "-A");
        git(wt, "commit", "-qm", "merge main");
        const sha = head();
        expect(git(wt, "rev-list", "--parents", "-n1", sha).trim().split(" ")).toHaveLength(3);
        return sha;
      };

      it("sends a merge commit that is in run_commits", async () => {
        mergeMain("docs/main.md");
        const sha = concludeMerge();
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha, at: NOW });
        expect((await push()).text).toBe(`Pushed ${sha.slice(0, 7)} to ${BRANCH}.`);
        expect(remoteTip()).toBe(sha);
      });

      it("refuses one that is not in run_commits", async () => {
        mergeMain("docs/main.md");
        concludeMerge();
        expect(await push()).toEqual({ text: MC_PUSH_MERGE, isError: true });
        expect(remoteTip()).toBeNull();
      });

      it("refuses a secret added in a merge resolution", async () => {
        mergeMain("apps/a.ts");
        write("apps/a.ts", `const t = "${TOKEN}";\n`);
        const sha = concludeMerge();
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha, at: NOW });
        const r = await push();
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/^Not pushed: apps\/a\.ts:\d+ looks like a GitHub token\./);
        expect(remoteTip()).toBeNull();
      });

      it("pushes an aside run's branch", async () => {
        mergeMain("docs/main.md");
        const sha = concludeMerge();
        store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha, at: NOW });
        // off its seat: the seat row is free, and the run says where its worktree is
        const row = store.seatSession("guido-1");
        if (row === null) throw new Error("no seat row");
        store.setSeatSession({ ...row, runId: null });
        store.setRunLoop(RUN, {
          ...NEW_LOOP,
          phase: "review",
          aside: { worktree: wt, wake: false },
        });
        expect((await push()).text).toBe(`Pushed ${sha.slice(0, 7)} to ${BRANCH}.`);
      });
    });

    it("refuses a clone that fails git fsck, for the operator, raising no item of its own", async () => {
      await commitOk("apps/a.ts", "a2\n");
      mkdirSync(join(clone, ".git", "objects", "ab"), { recursive: true });
      writeFileSync(
        join(clone, ".git", "objects", "ab", "cdef0123456789abcdef0123456789abcdef01"),
        "garbage",
      );
      expect(await push()).toEqual({
        text: "Not pushed: the session clone failed git fsck. Check the clone's health, then message the seat.",
        isError: true,
      });
      expect(remoteTip()).toBeNull();
      expect(store.crewErrors()).toEqual([]);
    });

    it("refuses a token in an added file: where, line and kind, a guard hit, never the token", async () => {
      recordedWithSecret("apps/x.ts", `const a = 1;\nconst t = "${TOKEN}";\n`);
      const r = await push();
      expect(r).toEqual({
        text: `Not pushed: apps/x.ts:2 looks like a GitHub token. ${SECRET_ASK}`,
        isError: true,
      });
      expect(remoteTip()).toBeNull();
      expect(store.guardHits(0).map((h) => [h.agentId, h.runId, h.rule, h.text])).toEqual([
        ["guido-1", RUN, "secret", "No secrets in a push: Mission Control's push"],
      ]);
      expect(emitted).toContain("guard");
      noSecretAnywhere([r.text]);
    });

    it("raises no Needs-you item of its own for a secret: the engine's Blocked note is the one", async () => {
      recordedWithSecret("apps/x.ts", `const a = 1;\nconst t = "${TOKEN}";\n`);
      emitted = [];
      const r = await push();
      expect(r.isError).toBe(true);
      expect(store.openQuestions()).toEqual([]);
      expect(store.crewErrors()).toEqual([]);
      expect(emitted).not.toContain("attention");
      const items = attentionItems(config(), store, NOW, NO_LOCK).filter(
        (i) => i.kind === "question" || i.kind === "error",
      );
      expect(items).toEqual([]);
      noSecretAnywhere([r.text]);
    });

    it("names a secret in a commit message by the commit, in the refusal", async () => {
      const sha = recordedWithSecret("apps/a.ts", "a2\n", `feat: x\n\nkey ${LOCAL}`);
      const r = await push();
      expect(r.text).toBe(
        `Not pushed: commit ${sha.slice(0, 7)}:3 looks like a local credential. ${SECRET_ASK}`,
      );
      expect(store.openQuestions()).toEqual([]);
      noSecretAnywhere([r.text]);
    });

    it("raises no question for a push that passes the scan", async () => {
      await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toMatch(/^Pushed /);
      expect(store.openQuestions()).toEqual([]);
    });

    it("finds a known secret in a file under * -diff", async () => {
      writeFileSync(join(clone, ".git", "info", "attributes"), "* -diff\n");
      recordedWithSecret("apps/blob.dat", `bin\n${LOCAL}\n`);
      expect((await push()).text).toBe(
        `Not pushed: apps/blob.dat:2 looks like a local credential. ${SECRET_ASK}`,
      );
      expect(remoteTip()).toBeNull();
    });

    it("finds a token in a commit later reverted", async () => {
      recordedWithSecret("apps/x.ts", `${TOKEN}\n`);
      await commitOk("apps/x.ts", "clean\n", "fix: drop it");
      expect((await push()).text).toBe(
        `Not pushed: apps/x.ts:1 looks like a GitHub token. ${SECRET_ASK}`,
      );
    });

    it("finds a token under a quoted path", async () => {
      recordedWithSecret('apps/q"x.ts', `${TOKEN}\n`);
      expect((await push()).text).toBe(
        `Not pushed: apps/q"x.ts:1 looks like a GitHub token. ${SECRET_ASK}`,
      );
    });

    it("reads a rename as the whole file added (--no-renames): it fails closed", async () => {
      git(clone, "checkout", "-q", "main");
      writeFileSync(join(clone, "apps", "old.ts"), `${LOCAL}\n`);
      git(clone, "add", "-A");
      git(clone, "commit", "-qm", "the operator's fixture");
      git(clone, "push", "-q", "origin", "main");
      git(wt, "merge", "-q", "--ff-only", "main");
      renameSync(join(wt, "apps", "old.ts"), join(wt, "apps", "new.ts"));
      // the commit tool reads it the same way now; a commit made before that is pushed so
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", "refactor: move");
      store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: head(), at: NOW });
      expect((await push()).text).toBe(
        `Not pushed: apps/new.ts:1 looks like a local credential. ${SECRET_ASK}`,
      );
    });

    it("finds a token in a commit message", async () => {
      const sha = recordedWithSecret("apps/a.ts", "a2\n", `feat: x\n\nkey ${TOKEN}`);
      expect((await push()).text).toBe(
        `Not pushed: commit ${sha.slice(0, 7)}:3 looks like a GitHub token. ${SECRET_ASK}`,
      );
    });

    it("finds a token a commit message hides on a fake diff's removed line", async () => {
      const message = `feat: x\n\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-${TOKEN}\n+ok`;
      const sha = recordedWithSecret("apps/a.ts", "a2\n", message);
      expect((await push()).text).toBe(
        `Not pushed: commit ${sha.slice(0, 7)}:7 looks like a GitHub token. ${SECRET_ASK}`,
      );
    });

    it.each([
      ["a closing keyword", "fix: x\n\nFixes #42", "Fixes #42"],
      ["another issue", "feat: x, see #7", "#7"],
      ["another repo's issue", "feat: x, like o/other#3", "o/other#3"],
      ["a mention", "feat: x, thanks @octocat", "@octocat"],
    ])("refuses %s in a commit message (the push's backstop)", async (_what, message, what) => {
      const sha = hubRecorded(message);
      expect(await push()).toEqual({
        text: `Not pushed: commit ${sha.slice(0, 7)}'s message would notify or close something on GitHub (${what}). The seat cannot rewrite a commit, so only you can reword it; then message the seat to carry on.`,
        isError: true,
      });
      expect(remoteTip()).toBeNull();
    });

    it("passes the run's own issue and an email address in a message", async () => {
      const sha = await commitOk(
        "apps/a.ts",
        "a2\n",
        "feat: x (#42)\n\nUses `mc` core; reported by you@example.com.",
      );
      expect((await push()).text).toBe(`Pushed ${sha.slice(0, 7)} to ${BRANCH}.`);
    });

    it("a later run on a ticket already on origin sends only its own commits; the operator's there are not re-checked", async () => {
      await commitOk("apps/a.ts", "a2\n");
      await push();
      operatorPushes("docs/operator.md");
      git(clone, "fetch", "-q", "origin");
      git(wt, "merge", "-q", "--ff-only", `origin/${BRANCH}`);
      const second = nextRun("guido-1:20261020T130000Z");
      const mine = await commitOk("apps/a.ts", "a3\n", "feat: second", second);
      const seen: Record<string, string[]> = {};
      const r = await push(ts({ git: recording(["rev-list"], seen) }), second);
      expect(r.text).toBe(`Pushed ${mine.slice(0, 7)} to ${BRANCH}.`);
      expect(
        seen["rev-list"]
          ?.join("")
          .trim()
          .split("\n")
          .map((l) => l.split(" ")[0]),
      ).toEqual([mine]);
      expect(store.runPush(second.runId)?.sha).toBe(mine);
    });

    it("a pushed head that contains the run's newest commit becomes its newest commit", async () => {
      const own = await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toBe(`Pushed ${own.slice(0, 7)} to ${BRANCH}.`);
      operatorPushes("docs/main.md", "main");
      git(clone, "fetch", "-q", "origin");
      git(wt, "merge", "--no-ff", "-q", "-m", `Merge main into ${BRANCH}`, "origin/main");
      const merge = head();
      // recorded under an earlier run of the branch, so the run's own newest is still `own`
      store.addRunCommit({ runId: "earlier", repoId: "mc", branch: BRANCH, sha: merge, at: NOW });
      expect(store.newestRunCommit(RUN)?.sha).toBe(own);
      expect((await push()).text).toBe(`Pushed ${merge.slice(0, 7)} to ${BRANCH}.`);
      expect(store.newestRunCommit(RUN)?.sha).toBe(merge);
      expect(store.runPush(RUN)?.sha).toBe(merge);
    });

    it("a head already on origin that contains the run's newest commit becomes its newest commit", async () => {
      const own = await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toBe(`Pushed ${own.slice(0, 7)} to ${BRANCH}.`);
      operatorPushes("docs/main.md", "main");
      git(clone, "fetch", "-q", "origin");
      git(wt, "merge", "--no-ff", "-q", "-m", `Merge main into ${BRANCH}`, "origin/main");
      const merge = head();
      store.addRunCommit({ runId: "earlier", repoId: "mc", branch: BRANCH, sha: merge, at: NOW });
      git(wt, "push", "-q", "origin", `${merge}:refs/heads/${BRANCH}`);
      expect((await push()).text).toBe(alreadyOnOriginText(merge));
      expect(store.newestRunCommit(RUN)?.sha).toBe(merge);
    });

    it("a commit someone else put on origin is not recorded as the run's, even when it descends from the newest", async () => {
      const own = await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toBe(`Pushed ${own.slice(0, 7)} to ${BRANCH}.`);
      const foreign = operatorPushes("docs/operator.md");
      git(clone, "fetch", "-q", "origin");
      git(wt, "merge", "-q", "--ff-only", `origin/${BRANCH}`);
      expect((await push()).text).toBe(alreadyOnOriginText(foreign));
      expect(store.branchCommits("mc", BRANCH).has(foreign)).toBe(false);
      expect(store.newestRunCommit(RUN)?.sha).toBe(own);
    });

    it("a pushed head that does not contain the run's newest commit leaves it as it was", async () => {
      const own = await commitOk("apps/a.ts", "a2\n");
      git(wt, "reset", "-q", "--hard", `${own}^`);
      write("apps/b.ts", "b\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", "feat: b");
      const other = head();
      store.addRunCommit({ runId: "earlier", repoId: "mc", branch: BRANCH, sha: other, at: NOW });
      expect((await push()).text).toBe(`Pushed ${other.slice(0, 7)} to ${BRANCH}.`);
      expect(store.newestRunCommit(RUN)?.sha).toBe(own);
    });

    it("a run that ended unpushed leaves its commits to the next run's push, which sends both", async () => {
      const first = await commitOk("apps/a.ts", "a2\n");
      const second = nextRun("guido-1:20261020T130000Z");
      const mine = await commitOk("apps/a.ts", "a3\n", "feat: second", second);
      const seen: Record<string, string[]> = {};
      expect((await push(ts({ git: recording(["rev-list"], seen) }), second)).text).toBe(
        `Pushed ${mine.slice(0, 7)} to ${BRANCH}.`,
      );
      expect(
        new Set(
          seen["rev-list"]
            ?.join("")
            .trim()
            .split("\n")
            .map((l) => l.split(" ")[0]),
        ),
      ).toEqual(new Set([first, mine]));
      expect(remoteTip()).toBe(mine);
    });

    it.each([
      ["the default branch", "main"],
      ["another ticket's branch", "feature/7-other-ticket"],
    ])("refuses to push %s: the merge-push rule, and a guard hit", async (_what, branch) => {
      await commitOk("apps/a.ts", "a2\n");
      store.upsertRun(run({ branch }));
      const mainBefore = remoteTip("main");
      expect(await push()).toEqual({
        text: "Not pushed: No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode",
        isError: true,
      });
      expect(remoteTip("main")).toBe(mainBefore);
      expect(remoteTip(branch === "main" ? BRANCH : branch)).toBeNull();
      expect(store.runPush(RUN)).toBeNull();
      expect(store.guardHits(0).map((h) => [h.rule, h.text])).toEqual([
        [
          "merge-push",
          "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode: Mission Control's push",
        ],
      ]);
    });

    it("refuses a branch another live run has", async () => {
      await commitOk("apps/a.ts", "a2\n");
      liveSeat("guido-2", "guido-2:1"); // its run row names the same branch
      expect((await push()).text).toBe(
        "Not pushed: No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode",
      );
      expect(remoteTip()).toBeNull();
    });

    it("refuses an ended run and a read-only seat", async () => {
      await commitOk("apps/a.ts", "a2\n");
      liveSeat("retro", "retro:1");
      expect(await push(ts(), { seatId: "retro", runId: "retro:1" })).toEqual({
        text: "Read-only roles cannot write: push is for writer seats.",
        isError: true,
      });
      store.upsertRun(run({ endedAt: NOW, status: "ok" }));
      expect(await push()).toEqual({ text: MC_RUN_ENDED, isError: true });
      expect(remoteTip()).toBeNull();
    });

    it("answers a scan log past its cap with a fixed text, pushing nothing", async () => {
      await commitOk("apps/a.ts", "a2\n");
      const tiny: McToolsDeps["git"] = async (cwd, args, common, o) =>
        crewGit(cwd, args, common, args.includes("-p") ? { ...o, maxBuffer: 10 } : o);
      expect(await push(ts({ git: tiny }))).toEqual({
        text: "Not pushed: the new commits are too large for the secret scan to read, so nothing was pushed unread. Push them yourself if they are fine, then message the seat.",
        isError: true,
      });
      expect(remoteTip()).toBeNull();
    });

    it("fetches origin's default tip when the clone lacks it, and still sends only the run's commits", async () => {
      const operatorMain = operatorPushes("docs/main.md", "main"); // the clone has not fetched it
      const sha = await commitOk("apps/a.ts", "a2\n");
      const seen: Record<string, string[]> = {};
      expect((await push(ts({ git: recording(["rev-list"], seen) }))).text).toBe(
        `Pushed ${sha.slice(0, 7)} to ${BRANCH}.`,
      );
      expect(
        seen["rev-list"]
          ?.join("")
          .trim()
          .split("\n")
          .map((l) => l.split(" ")[0]),
      ).toEqual([sha]);
      expect(git(clone, "cat-file", "-t", operatorMain).trim()).toBe("commit");
    });

    it("is exported as pushRun for the engine to call", async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      expect(await pushRun(pushDeps(), RUN)).toEqual({
        text: `Pushed ${sha.slice(0, 7)} to ${BRANCH}.`,
      });
    });
  });

  describe("draft_pr", () => {
    const pushed = async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toMatch(/^Pushed /);
      return sha;
    };

    it("opens one draft PR for the pushed branch, through gh, and answers its URL", async () => {
      await pushed();
      process.env.MC_TEST_LEAK = "leaked";
      let r: { text: string; isError?: boolean };
      try {
        r = await pr("feat: the thing", "It does the thing.");
      } finally {
        delete process.env.MC_TEST_LEAK;
      }
      expect(r).toEqual({ text: PR_URL });
      const crew = join(dir, "data", "crew");
      const calls = ghCalls();
      expect(calls).toHaveLength(2);
      const [list, create] = calls;
      expect(list?.args).toEqual([
        "pr",
        "list",
        "--repo=o/mc",
        `--head=${BRANCH}`,
        "--state=open",
        "--json=url",
      ]);
      expect(create?.args.slice(0, -1)).toEqual([
        "pr",
        "create",
        "--repo=o/mc",
        "--draft",
        `--head=${BRANCH}`,
        "--base=main",
        "--title=feat: the thing",
      ]);
      expect(create?.args.at(-1)).toBe(`--body-file=${create?.bodyFile}`);
      expect(create?.cwd).toBe(realpathSync(crew));
      expect(create?.bodyFile?.startsWith(`${crew}/`)).toBe(true);
      expect(create?.mode).toBe("600");
      expect(create?.body).toBe(
        "It does the thing.\n\nCloses #42.\n\nOpened by GUIDO-1 (Mission Control).\n",
      );
      for (const c of calls) {
        expect(
          Object.keys(c.env)
            .filter((k) => !k.startsWith("__CF"))
            .sort(),
        ).toEqual(GH_ENV_KEYS);
        expect(c.env.GH_PROMPT_DISABLED).toBe("1");
      }
      // the body file is gone
      expect(existsSync(create?.bodyFile ?? "")).toBe(false);
    });

    it("adds no closing line when the body already closes the run's issue", async () => {
      await pushed();
      await pr("feat: x", "Fixes #42.");
      expect(ghCalls()[1]?.body).toBe("Fixes #42.\n\nOpened by GUIDO-1 (Mission Control).\n");
    });

    it("adds the closing line when the body only mentions the run's issue", async () => {
      await pushed();
      await pr("feat: x", "Refs #42.");
      expect(ghCalls()[1]?.body).toBe(
        "Refs #42.\n\nCloses #42.\n\nOpened by GUIDO-1 (Mission Control).\n",
      );
    });

    it("refuses before a push, and after a commit the push has not sent", async () => {
      const text = { text: "Push first: the PR shows what is on origin.", isError: true };
      expect(await pr("feat: x", "body")).toEqual(text);
      await pushed();
      await commitOk("apps/a.ts", "a3\n");
      expect(await pr("feat: x", "body")).toEqual(text);
      expect(ghCalls()).toEqual([]);
    });

    it("answers with the open PR instead of opening a second", async () => {
      await pushed();
      ghState({ "pr list": { stdout: '[{"url":"https://github.com/o/mc/pull/5"}]\n' } });
      expect(await pr("feat: x", "body")).toEqual({
        text: "A PR is already open: https://github.com/o/mc/pull/5",
      });
      expect(ghCalls().map((c) => c.args[1])).toEqual(["list"]);
    });

    it("refuses a token in the body or a known secret in the title, with a guard hit and no gh call", async () => {
      await pushed();
      const body = await pr("feat: x", `fine\nthen ${TOKEN}`);
      expect(body).toEqual({
        text: prSecretText("PR body", 2, "GitHub token"),
        isError: true,
      });
      const title = await pr(`feat: ${LOCAL}`, "fine");
      expect(title.text).toBe(prSecretText("PR title", 1, "local credential"));
      expect(store.guardHits(0).map((h) => [h.rule, h.text])).toEqual([
        ["secret", "No secrets in a push: Mission Control's draft PR"],
        ["secret", "No secrets in a push: Mission Control's draft PR"],
      ]);
      expect(ghCalls()).toEqual([]);
      noSecretAnywhere([body.text, title.text]);
    });

    it.each([
      ["a mention", "thanks @octocat", "@octocat"],
      ["a cross-repo reference", "like o/other#3", "o/other#3"],
      [
        "another repo's PR link",
        "see https://github.com/x/y/pull/1",
        "https://github.com/x/y/pull/1",
      ],
    ])("refuses %s", async (_what, body, first) => {
      await pushed();
      expect(await pr("feat: x", body)).toEqual({ text: prNotifyText(first), isError: true });
      expect(ghCalls()).toEqual([]);
    });

    it("refuses a mention in the title", async () => {
      await pushed();
      expect((await pr("feat: x for @octocat", "body")).text).toBe(prNotifyText("@octocat"));
    });

    it("passes an email address and a package name without its @ (round 4)", async () => {
      await pushed();
      const body = "Uses `mc/core`; by you@example.com.\n\n```\nrun mc/core here\n```\n";
      expect(await pr("feat: x", body)).toEqual({ text: PR_URL });
    });

    it.each([
      ["a code span", "Uses `@mc/core`.", "@mc/core"],
      ["a code block", "```\nping @octocat\n```\n", "@octocat"],
      ["a character reference", "thanks &#64;octocat", "@octocat (written as &#64;octocat)"],
      ["another issue in a code span", "Run `gh issue view #7`.", "#7"],
    ])("refuses a mention or reference in %s (round 4)", async (_what, body, first) => {
      await pushed();
      expect(await pr("feat: x", body)).toEqual({ text: prNotifyText(first), isError: true });
      expect(ghCalls()).toEqual([]);
    });

    it("refuses a mention in a title's code span (round 4)", async () => {
      await pushed();
      expect((await pr("feat: `@octocat`", "body")).text).toBe(prNotifyText("@octocat"));
      expect(ghCalls()).toEqual([]);
    });

    it("answers a gh failure with a fixed text and logs it with known secrets redacted", async () => {
      await pushed();
      known = [LOCAL, TOKEN];
      ghState({ "pr list": { code: 1, stderr: `HTTP 401 for token ${TOKEN} / ${LOCAL}\n` } });
      const r = await pr("feat: x", "body");
      expect(r).toEqual({
        text: "Not opened: GitHub could not be reached through gh. Check the connection and your GitHub access, then message the seat to try again.",
        isError: true,
      });
      expect(logs.some((l) => l.includes("[redacted]"))).toBe(true);
      noSecretAnywhere([r.text]);
    });

    it("takes the longest title and body", async () => {
      await pushed();
      expect(await pr("x".repeat(200), "x".repeat(20_000))).toEqual({ text: PR_URL });
    });

    it("refuses an ended run and a read-only seat", async () => {
      await pushed();
      liveSeat("retro", "retro:1");
      expect(await pr("t", "b", ts(), { seatId: "retro", runId: "retro:1" })).toEqual({
        text: "Read-only roles cannot write: draft_pr is for writer seats.",
        isError: true,
      });
      store.upsertRun(run({ endedAt: NOW, status: "ok" }));
      expect(await pr("t", "b")).toEqual({ text: MC_RUN_ENDED, isError: true });
      expect(ghCalls()).toEqual([]);
    });

    it("is exported as openDraftPr for the engine to call", async () => {
      await pushed();
      expect(await openDraftPr(pushDeps(), RUN, { title: "t", body: "b" })).toEqual({
        text: PR_URL,
      });
    });
  });

  describe("fix round 1", () => {
    const pushed = async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toMatch(/^Pushed /);
      return sha;
    };
    const notify = (first: string) => ({ text: prNotifyText(first), isError: true });

    it("refuses a raw-git commit beneath a hub commit (finding 11)", async () => {
      write("apps/a.ts", "raw\n");
      git(wt, "commit", "-qam", "raw commit");
      const raw = head();
      await commitOk("apps/b.ts", "hub\n");
      expect(await push()).toEqual({ text: FOREIGN(raw), isError: true });
      expect(store.crewErrors()).toEqual([]);
      expect(remoteTip()).toBeNull();
    });

    it("reads files as stored, not through a textconv driver (finding 12)", async () => {
      writeFileSync(join(clone, ".git", "info", "attributes"), "*.dat diff=hide\n");
      git(clone, "config", "diff.hide.textconv", "true");
      recordedWithSecret("apps/k.dat", `${TOKEN}\n`);
      expect((await push()).text).toBe(
        `Not pushed: apps/k.dat:1 looks like a GitHub token. ${SECRET_ASK}`,
      );
    });

    it("answers a branch with no commit with its own text, not the connection one", async () => {
      await commitOk("apps/a.ts", "a2\n");
      git(wt, "update-ref", "-d", `refs/heads/${BRANCH}`);
      expect(await push()).toEqual({ text: MC_PUSH_NO_COMMIT, isError: true });
      expect(remoteTip()).toBeNull();
    });

    it("refuses a commit with no parent with its own text, not the merge one (finding 15)", async () => {
      const tree = git(wt, "rev-parse", "HEAD^{tree}").trim();
      const root = git(wt, "commit-tree", tree, "-m", "root").trim();
      git(wt, "update-ref", `refs/heads/${BRANCH}`, root);
      store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: root, at: NOW });
      expect(await push()).toEqual({
        text: MC_PUSH_ROOT,
        isError: true,
      });
      expect(remoteTip()).toBeNull();
    });

    it.each([
      [
        "another repo's issue link",
        "see https://github.com/o/other/issues/5",
        "https://github.com/o/other/issues/5",
      ],
      [
        "another own-repo issue link",
        "see https://github.com/o/mc/issues/99",
        "https://github.com/o/mc/issues/99",
      ],
      ["GH-n", "see GH-99", "GH-99"],
      ["Fixes GH-n", "Fixes GH-99", "Fixes GH-99"],
      ["a team mention", "chore: bump @mc/core", "@mc/core"],
    ])("refuses %s in a commit message (finding 3, ruling 7)", async (_what, message, what) => {
      const sha = hubRecorded(message);
      expect((await push()).text).toBe(
        `Not pushed: commit ${sha.slice(0, 7)}'s message would notify or close something on GitHub (${what}). The seat cannot rewrite a commit, so only you can reword it; then message the seat to carry on.`,
      );
    });

    it("reads the known secrets before the clone's queue, with a timeout, and says when it cannot (findings 5, 6)", async () => {
      const sha = await commitOk("apps/a.ts", "a2\n");
      const order: string[] = [];
      const r = await push(
        ts({
          knownSecrets: () => {
            order.push("known");
            return new Promise<string[]>(() => {}); // gh auth token hung
          },
          knownSecretsTimeoutMs: 50,
          inClone: async (_checkout, fn) => {
            order.push("queue");
            return fn();
          },
        }),
      );
      expect(r.text).toBe(`Pushed ${sha.slice(0, 7)} to ${BRANCH}.`);
      expect(order).toEqual(["known", "queue"]);
      expect(logs).toEqual(["mc push: could not read the known secrets; scanning by pattern only"]);
    });

    it("logs a known-secret read that throws with a fixed line, never its error (finding 6)", async () => {
      await commitOk("apps/a.ts", "a2\n");
      await push(
        ts({
          knownSecrets: async () => {
            throw new Error(`gh said ${LOCAL}`);
          },
        }),
      );
      expect(logs).toEqual(["mc push: could not read the known secrets; scanning by pattern only"]);
    });

    it("refuses a title that opens with a fence: a title has no code blocks (finding 1)", async () => {
      await pushed();
      expect(await pr("```x @octocat", "body")).toEqual(notify("@octocat"));
      expect(await pr("```x other/repo#5", "body")).toEqual(notify("other/repo#5"));
      expect(ghCalls()).toEqual([]);
    });

    it("refuses a mention in a fence inside an HTML block (finding 2)", async () => {
      await pushed();
      expect(await pr("feat: x", "<details>\n```\n@octocat\n```\n</details>")).toEqual(
        notify("@octocat"),
      );
    });

    it("refuses a team mention and a closing keyword for another issue (rulings 7, 9)", async () => {
      await pushed();
      expect(await pr("feat: x", "cc @org/team")).toEqual(notify("@org/team"));
      expect(await pr("feat: x", "Fixes #99")).toEqual(notify("Fixes #99"));
      expect(ghCalls()).toEqual([]);
      expect(await pr("feat: x", "Fixes #42")).toEqual({ text: PR_URL });
      expect(ghCalls()[1]?.body).toBe("Fixes #42\n\nOpened by GUIDO-1 (Mission Control).\n");
    });

    it.each([
      ["an unclosed fence", "Notes:\n```\nraw output"],
      ["an unclosed HTML comment", "Notes <!-- todo\n<!-- still open"],
    ])(
      "refuses a body that ends in %s, which would swallow the hub's lines (finding 8)",
      async (_what, body) => {
        await pushed();
        expect(await pr("feat: x", body)).toEqual({
          text: MC_PR_UNCLOSED,
          isError: true,
        });
        expect(ghCalls()).toEqual([]);
      },
    );

    it("adds Closes when the only closing keyword is inside code", async () => {
      await pushed();
      await pr("feat: x", "Run `Fixes #42`.");
      expect(ghCalls()[1]?.body).toBe(
        "Run `Fixes #42`.\n\nCloses #42.\n\nOpened by GUIDO-1 (Mission Control).\n",
      );
    });

    it("serialises a run's draft_pr calls: the second answers with the open PR (finding 10)", async () => {
      await pushed();
      ghState({
        "pr list": { stdout: "[]\n" },
        "pr create": { stdout: `${PR_URL}\n`, marksOpen: true },
      });
      const d = pushDeps();
      const gh = d.gh;
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let lists = 0;
      d.gh = async (args, opts) => {
        if (args[0] === "pr" && args[1] === "list") {
          lists++;
          await gate;
        }
        return gh(args, opts);
      };
      const first = openDraftPr(d, RUN, { title: "t", body: "b" });
      await vi.waitFor(() => expect(lists).toBe(1));
      const second = openDraftPr(d, RUN, { title: "t", body: "b" });
      try {
        await new Promise<void>((r) => setImmediate(r));
        expect(lists).toBe(1);
      } finally {
        release();
      }
      const both = await Promise.all([first, second]);
      expect(both.map((r) => r.text).sort()).toEqual(
        [PR_URL, `A PR is already open: ${PR_URL}`].sort(),
      );
      expect(ghCalls().filter((c) => c.args[1] === "create")).toHaveLength(1);
    });
  });

  describe("fix round 2", () => {
    it.each([
      ["a scope that is a team mention", "fix(@mc/core): x", "@mc/core"],
      ["a closing keyword", "fix: x\n\nFixes #42", "Fixes #42"],
      ["another issue", "feat: x, see #7", "#7"],
      ["a mention", "feat: x, thanks @octocat", "@octocat"],
    ])(
      "the commit tool refuses %s before committing, so the seat can reword (N1)",
      async (_what, message, what) => {
        const base = head();
        write("apps/a.ts", "a2\n");
        expect(await tool("commit", ts()).call(CTX, { message })).toEqual({
          text: `Not committed: the message would notify or close something on GitHub (${what}); reword it, then commit again. Write package names without the @ (mc/core, not @mc/core) and describe other issues in words, without # or links.`,
          isError: true,
        });
        expect(head()).toBe(base);
        expect(staged()).toBe("");
        expect(store.runCommits(RUN)).toEqual([]);
        // reworded, it commits
        expect(
          (await tool("commit", ts()).call(CTX, { message: "fix(core): x (#42)" })).text,
        ).toMatch(/^Committed /);
      },
    );
  });

  describe("fix round 5", () => {
    const pushed = async () => {
      await commitOk("apps/a.ts", "a2\n");
      expect((await push()).text).toMatch(/^Pushed /);
    };
    const namedPr = (ref: string) => ({
      text: prNamedRefText(ref),
      isError: true,
    });

    it.each([
      ["the body", "feat: x", "see torvalds&sol;linux#9"],
      ["the title", "feat: o&sol;r#42", "body"],
      ["the body, without its ;", "feat: x", "Closes o&sol r#9"],
    ])(
      "draft_pr refuses a named reference outside the allow-list in %s",
      async (_w, title, body) => {
        await pushed();
        const ref = /&sol;?/.exec(`${title} ${body}`)?.[0] ?? "";
        expect(await pr(title, body)).toEqual(namedPr(ref));
        expect(ghCalls()).toEqual([]);
      },
    );

    it("draft_pr passes an allowed &amp; and refuses a github.com URL with a port", async () => {
      await pushed();
      expect((await pr("feat: x", "https://github.com:443/o/r/issues/9")).text).toBe(
        prNotifyText("https://github.com:443/o/r/issues/9"),
      );
      expect(await pr("feat: x &amp; y", "R &amp; D")).toEqual({ text: PR_URL });
    });

    it("the commit tool refuses a named reference before committing", async () => {
      const base = head();
      write("apps/a.ts", "a2\n");
      expect(await tool("commit", ts()).call(CTX, { message: "fix: o&sol;r#9" })).toEqual({
        text: "Not committed: &sol; is an HTML character reference GitHub would turn into another character; write the character itself, then commit again.",
        isError: true,
      });
      expect(head()).toBe(base);
      expect(store.runCommits(RUN)).toEqual([]);
    });

    it("the push backstop refuses a named reference in an older commit's message", async () => {
      const sha = hubRecorded("fix: see o&period;x");
      expect((await push()).text).toBe(
        `Not pushed: commit ${sha.slice(0, 7)}'s message would notify or close something on GitHub (&period;). The seat cannot rewrite a commit, so only you can reword it; then message the seat to carry on.`,
      );
      expect(remoteTip()).toBeNull();
    });
  });

  describe("logging", () => {
    it("nothing logged holds a known secret: a failed push through /mcp, the server log and the tools' log", async () => {
      known = [LOCAL, TOKEN];
      const sha = await commitOk("apps/a.ts", "a2\n");
      // origin answers ls-remote, but the push goes to a path that is the token
      git(clone, "config", "remote.origin.pushurl", join(dir, "nowhere", TOKEN));
      const cfg = config();
      const tokens = new RunTokens();
      const bearerToken = tokens.issue("guido-1", RUN);
      const server: string[] = [];
      const app = buildApp({
        config: cfg,
        store,
        bus,
        tokens,
        mcpTools: () => ts(),
        seatMode: (id) => crewSeatMode(cfg, id),
        logger: { stream: { write: (m: string) => void server.push(m) } },
      });
      await app.ready();
      const answers: string[] = [];
      try {
        const call = async (name: string, args: unknown) => {
          const r = await app.inject({
            method: "POST",
            url: "/mcp",
            headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
            payload: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
          const text = r.json().result.content[0].text as string;
          answers.push(text);
          return text;
        };
        expect(await call("push", {})).toBe(
          "Not pushed: git could not push to origin. Check the connection and your GitHub access, then message the seat to try again.",
        );
        expect(logs.some((l) => l.includes("[redacted]"))).toBe(true);
        git(clone, "config", "--unset", "remote.origin.pushurl");
        recordedWithSecret("apps/k.ts", `${LOCAL}\n`);
        expect(await call("push", {})).toMatch(
          /^Not pushed: apps\/k\.ts:1 looks like a local credential/,
        );
        expect(remoteTip()).toBeNull();
        expect(sha).not.toBe(head());
      } finally {
        await app.close();
      }
      expect(server.join("\n")).not.toContain(TOKEN);
      expect(server.join("\n")).not.toContain(LOCAL);
      noSecretAnywhere(answers);
    });
  });
});

describe("the gh wrapper", () => {
  let ghDir: string;
  beforeEach(() => {
    ghDir = join(dir, "fakegh");
    mkdirSync(ghDir);
    writeFileSync(join(ghDir, "gh"), FAKE_GH, { mode: 0o755 });
  });

  it("runs with PATH and HOME only, prompts off, and returns a failure's code and streams", async () => {
    writeFileSync(
      join(ghDir, "state.json"),
      JSON.stringify({ "api user": { code: 4, stdout: "out", stderr: "err" } }),
    );
    process.env.MC_TEST_LEAK = "leaked";
    try {
      const r = await createGh(join(ghDir, "gh"))(["api", "user"], { cwd: dir });
      expect(r).toEqual({ code: 4, stdout: "out", stderr: "err" });
    } finally {
      delete process.env.MC_TEST_LEAK;
    }
    const call = JSON.parse(readFileSync(join(ghDir, "calls.jsonl"), "utf8")) as GhCall;
    expect(
      Object.keys(call.env)
        .filter((k) => !k.startsWith("__CF"))
        .sort(),
    ).toEqual(GH_ENV_KEYS);
    expect(call.cwd).toBe(dir);
  });

  it("kills gh at its timeout and answers code null", async () => {
    writeFileSync(join(ghDir, "state.json"), JSON.stringify({ "pr list": { sleepMs: 5000 } }));
    const started = Date.now();
    const r = await createGh(join(ghDir, "gh"))(["pr", "list"], { cwd: dir, timeoutMs: 200 });
    expect(r.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it("answers code null for a gh that cannot be started", async () => {
    const r = await createGh(join(dir, "missing-gh"))(["pr", "list"], { cwd: dir });
    expect(r.code).toBeNull();
  });

  it("honours MC_GH_COMMAND only on a preview with MC_CREW=1, and says once when it ignores it", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(ghCommand({ MC_GH_COMMAND: "/fake/gh", MC_CREW: "1" }, true, log)).toBe("/fake/gh");
    expect(lines).toEqual([]);
    expect(ghCommand({ MC_GH_COMMAND: "/fake/gh", MC_CREW: "1" }, false, log)).toBe("gh");
    expect(ghCommand({ MC_GH_COMMAND: "/fake/gh" }, true, log)).toBe("gh");
    expect(ghCommand({}, false, log)).toBe("gh");
    expect(lines).toEqual([
      "MC_GH_COMMAND is ignored: only a preview started with MC_CREW=1 honours it",
      "MC_GH_COMMAND is ignored: only a preview started with MC_CREW=1 honours it",
    ]);
  });
});

// ---------- Plan 7a Task 2: report_evidence ----------

describe("report_evidence", () => {
  const LOOP: RunLoop = {
    phase: "working",
    reportedEvidenceId: 0,
    prNumber: null,
    pushStartedAt: null,
    pushFor: null,
    unparkedAt: null,
    ciFails: 0,
    ciFailedSha: null,
    relayedSha: null,
    transient: 0,
    lastRefusal: null,
    epoch: 0,
    budgetExtra: 0,
    parked: null,
    touches: null,
    cardFor: null,
  };
  let clock: number;
  let told: [string, string][];
  let ev: McTool[];
  const setLoop = (over: Partial<RunLoop> = {}) => store.setRunLoop(RUN, { ...LOOP, ...over });
  const report = (note: unknown, ctx: McToolContext = CTX) =>
    tool("report_evidence", ev).call(ctx, note === undefined ? {} : { note });
  /** A committed change, one tick after the last thing that happened. */
  const committed = async (rel = "apps/a.ts", text = `${clock}\n`) => {
    clock += 1000;
    write(rel, text);
    const r = await commit(`feat: ${rel}`, ev);
    expect(r.text).toMatch(/^Committed /);
    return head();
  };
  const finding: ReviewFinding = {
    severity: "Important",
    file: "apps/a.ts",
    line: 1,
    summary: "missing case",
    scenario: "a reply has no test",
    fix: "add a test",
  };
  const startReview = (
    sha: string,
    { epoch = 0, attempt = 1, blocking = true, running = false } = {},
  ): number => {
    const review = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha,
      epoch,
      attempt,
      round: attempt,
      at: clock,
    });
    if (review === null) throw new Error("review was not queued");
    store.setReviewState(review, ["queued"], "running", { at: clock, runId: `retro:${review}` });
    if (!running) {
      store.recordFindings(review, `retro:${review}`, {
        verdict: { spec: blocking ? "fail" : "pass", quality: "pass" },
        summary: blocking ? "hold" : "clean",
        findings: blocking ? [finding] : [],
        at: clock,
      });
    }
    return review;
  };
  const claimFix = (review: number, epoch = 0) =>
    store.claimLine(fixKey(RUN, epoch, review), {
      runId: RUN,
      seatId: "guido-1",
      origin: "engine",
      text: "fix",
      at: clock,
    });
  const reviewedHead = async () => {
    const sha = await committed();
    expect(await report("Initial fix report.")).toEqual({ text: EVIDENCE_RECORDED });
    const evidence = store.latestEvidence(RUN);
    if (evidence === null) throw new Error("evidence was not recorded");
    store.setRunPush({ runId: RUN, sha, at: clock });
    setLoop({ phase: "review", reportedEvidenceId: evidence.id });
    return sha;
  };
  const refused = (text: string) => ({ text, isError: true });

  beforeEach(() => {
    clock = NOW;
    told = [];
    ev = make({ now: () => clock, onEvidence: (s, r) => told.push([s, r]) });
    setLoop();
  });

  it("accepts a removal commit", async () => {
    clock += 1000;
    expect((await rm(["apps/a.ts"], "chore: drop a", ev)).text).toMatch(/^Removed .*\nCommitted /);
    expect(await report("done")).toEqual({ text: EVIDENCE_RECORDED });
  });

  it("records build-seat test runs and tests added", async () => {
    await committed();
    expect(
      await tool("report_evidence", ev).call(CTX, {
        note: "tested",
        tests: [
          {
            command: "pnpm -s vitest run apps/a.test.ts",
            file: "apps/a.test.ts",
            passed: 1,
            failed: 0,
            skipped: 0,
            duration: 12,
          },
        ],
        testsAdded: [{ file: "apps/a.test.ts", failedOnBase: true }],
      }),
    ).toEqual({ text: EVIDENCE_RECORDED });
    expect(store.latestEvidence(RUN)).toMatchObject({
      tests: [expect.objectContaining({ passed: 1, duration: 12 })],
      testsAdded: [{ file: "apps/a.test.ts", failedOnBase: true }],
    });
  });

  describe("the ticket's Done-when lines", () => {
    const LINES = ["Test: a report missing a Done-when entry is refused", "Audit shows rounds"];
    const answer = (line: number, status: "met" | "not_met" = "met", evidence = "a test") => ({
      line,
      status,
      evidence,
    });
    const reportWith = (doneWhen?: unknown) =>
      tool("report_evidence", ev).call(CTX, {
        note: "done",
        ...(doneWhen === undefined ? {} : { doneWhen }),
      });

    beforeEach(async () => {
      store.setRunDoneWhen(RUN, LINES);
      await committed();
    });

    it("refuses a report that leaves a line unaddressed, quoting the line", async () => {
      const r = await reportWith([answer(1)]);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('2. "Audit shows rounds"');
      expect(r.text).not.toContain("a report missing");
      expect(store.latestEvidence(RUN)).toBeNull();
    });

    it("refuses a report with no doneWhen, quoting every line", async () => {
      const r = await reportWith();
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`1. "${LINES[0]}"`);
      expect(r.text).toContain(`2. "${LINES[1]}"`);
    });

    it("refuses a line the ticket does not have, and a line named twice", async () => {
      expect((await reportWith([answer(1), answer(2), answer(3)])).isError).toBe(true);
      expect((await reportWith([answer(1), answer(1), answer(2)])).isError).toBe(true);
      expect(store.latestEvidence(RUN)).toBeNull();
    });

    it("records a report that addresses every line, met or not met", async () => {
      expect(
        await reportWith([answer(1, "met", "mcp-tools.test.ts"), answer(2, "not_met", "web")]),
      ).toEqual({ text: EVIDENCE_RECORDED });
      expect(store.latestEvidence(RUN)?.doneWhen).toEqual([
        { line: 1, text: LINES[0], status: "met", evidence: "mcp-tools.test.ts" },
        { line: 2, text: LINES[1], status: "not_met", evidence: "web" },
      ]);
    });

    it("a Ruling: note on a fresh commit still owes the table", async () => {
      const r = await tool("report_evidence", ev).call(CTX, { note: "Ruling: all done" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('1. "');
    });

    it("a Ruling: note on the sha CI failed, with no new commit, is recorded with no table", async () => {
      setLoop({ ciFailedSha: head() });
      expect(
        await tool("report_evidence", ev).call(CTX, { note: "Ruling: flaky, not mine" }),
      ).toEqual({ text: EVIDENCE_RECORDED });
      expect(store.latestEvidence(RUN)?.doneWhen).toEqual([]);
    });

    it("a Ruling: note with no new commit keeps the last table", async () => {
      expect(await reportWith([answer(1), answer(2)])).toEqual({ text: EVIDENCE_RECORDED });
      setLoop({ ciFailedSha: head() });
      expect(
        await tool("report_evidence", ev).call(CTX, { note: "Ruling: flaky, not mine" }),
      ).toEqual({ text: EVIDENCE_RECORDED });
      expect(store.latestEvidence(RUN)?.doneWhen).toHaveLength(2);
    });

    it("needs no doneWhen from a run whose ticket lines were not recorded", async () => {
      store.setRunDoneWhen(RUN, []);
      expect(await reportWith()).toEqual({ text: EVIDENCE_RECORDED });
    });
  });

  it("is offered to every mode", () => {
    expect(tool("report_evidence", ev).modes).toEqual(["writer", "read-only"]);
  });

  it("describes structured test evidence to MCP clients", () => {
    expect(tool("report_evidence", ev).inputSchema).toMatchObject({
      properties: {
        tests: {
          items: {
            properties: {
              command: { type: "string", minLength: 1 },
              passed: { type: "integer", minimum: 0 },
              duration: { type: "integer", minimum: 0 },
            },
            required: ["command", "passed", "failed", "skipped", "duration"],
            additionalProperties: false,
          },
        },
        testsAdded: {
          items: {
            properties: {
              file: { type: "string", minLength: 1 },
              failedOnBase: { type: "boolean" },
            },
            required: ["file", "failedOnBase"],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it("describes a no-commit response as a blocking-review reply", () => {
    const evidence = tool("report_evidence", ev);
    expect(evidence.description).toContain(
      "While responding to blocking review findings on the unchanged head",
    );
    const schema = evidence.inputSchema as {
      properties: { note: { description: string } };
    };
    expect(schema.properties.note.description).toContain("unchanged blocking review");
    expect(schema.properties.note.description).toContain("Ruling: only for a CI decision");
  });

  it("answers EVIDENCE_NO_LOOP for a run no loop drives", async () => {
    store.setRunLoop(RUN, null);
    expect(await report("done")).toEqual(refused(EVIDENCE_NO_LOOP));
    expect(store.latestEvidence(RUN)).toBeNull();
    expect(told).toEqual([]);
  });

  it("answers the ended-run text for a run that has ended or is not the seat's", async () => {
    store.upsertRun(run({ endedAt: NOW, status: "ok" }));
    expect(await report("done")).toEqual(refused("This run has ended."));
    expect(await report("done", { seatId: "guido-2", runId: RUN })).toEqual(
      refused("This run has ended."),
    );
  });

  it("refuses, in order: parked, then in CI, then uncommitted, then no commit, then the text", async () => {
    write("apps/a.ts", "dirty\n");
    setLoop({ phase: "parked" });
    expect(await report("@someone done")).toEqual(refused(EVIDENCE_PARKED));
    setLoop({ phase: "ci" });
    expect(await report("@someone done")).toEqual(refused(EVIDENCE_IN_CI));
    setLoop({ phase: "working" });
    expect(await report("@someone done")).toEqual(refused(evidenceUncommittedText(["apps/a.ts"])));
    await commit("wip", ev);
    clock += 1000;
    expect(await report("@someone done")).toMatchObject({ isError: true });
    expect((await report("@someone done")).text).toContain("@someone");
    // the first report with no commit since: NO_COMMIT beats the text
    expect(await report("fine")).toEqual({ text: EVIDENCE_RECORDED });
    expect(await report("@someone done")).toEqual(refused(EVIDENCE_NO_COMMIT));
  });

  it.each(["review", "silent", "refused"])(
    "records fresh evidence and resumes a %s park",
    async (kind) => {
      setLoop({
        phase: "parked",
        parked: { kind, reason: "parked", ended: false },
        transient: 2,
        lastRefusal: "no",
      });
      await committed();
      expect(await report("fixed")).toEqual({ text: EVIDENCE_RECORDED });
      expect(store.run(RUN)?.loop).toMatchObject({
        phase: "working",
        parked: null,
        transient: 0,
        lastRefusal: null,
      });
      expect(told).toEqual([["guido-1", RUN]]);
    },
  );

  it.each(["budget", "account-stop"])("keeps a %s park held", async (kind) => {
    setLoop({ phase: "parked", parked: { kind, reason: "held", ended: false } });
    await committed();
    expect(await report("fixed")).toEqual(refused(EVIDENCE_PARKED));
    expect(store.latestEvidence(RUN)).toBeNull();
  });

  it("records a refused retry for the same pushed and reported head", async () => {
    const sha = await committed();
    expect(await report("first report")).toEqual({ text: EVIDENCE_RECORDED });
    const reported = store.latestEvidence(RUN);
    if (reported === null) throw new Error("evidence was not recorded");
    setLoop({
      phase: "parked",
      parked: { kind: "refused", reason: "refused", ended: false },
      pushFor: sha,
      reportedEvidenceId: reported.id,
    });

    expect(await report("retry after refusal")).toEqual({ text: EVIDENCE_RECORDED });
    expect(store.evidenceCount(RUN)).toBe(2);
    expect(store.run(RUN)?.loop).toMatchObject({ phase: "working", parked: null });
  });

  it("names up to ten uncommitted paths, untracked ones too, then how many more", async () => {
    for (let i = 0; i < 12; i++) write(`apps/f${String(i).padStart(2, "0")}.ts`, "x\n");
    const r = await report("done");
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      evidenceUncommittedText(
        Array.from({ length: 12 }, (_, i) => `apps/f${String(i).padStart(2, "0")}.ts`),
      ),
    );
    expect(r.text).toContain("apps/f09.ts and 2 more.");
    expect(r.text).not.toContain("apps/f10.ts");
    expect(store.latestEvidence(RUN)).toBeNull();
  });

  it("counts a staged change and a rename once, and leaves a .pnpm-store out", async () => {
    write(".pnpm-store/v11/index.db", "db\n");
    expect(await report("Ruling: x")).toEqual({ text: EVIDENCE_RECORDED });
    git(wt, "mv", "apps/a.ts", "apps/renamed.ts");
    const r = await report("Ruling: x");
    expect(r.text).toBe(evidenceUncommittedText(["apps/renamed.ts"]));
  });

  it("counts a rename in the worktree column once too (intent-to-add)", async () => {
    renameSync(join(wt, "apps/a.ts"), join(wt, "apps/renamed.ts"));
    git(wt, "add", "-N", "apps/renamed.ts");
    expect(git(wt, "status", "--porcelain=v1")).toMatch(/^ R /);
    const r = await report("Ruling: x");
    expect(r.text).toBe(evidenceUncommittedText(["apps/renamed.ts"]));
  });

  it("refuses no-loop, parked and in-CI without reading the known secrets", async () => {
    let reads = 0;
    const counted = make({
      now: () => clock,
      knownSecrets: async () => {
        reads++;
        return [];
      },
    });
    const call = () => tool("report_evidence", counted).call(CTX, { note: "done" });
    store.setRunLoop(RUN, null);
    expect(await call()).toEqual(refused(EVIDENCE_NO_LOOP));
    setLoop({ phase: "parked" });
    expect(await call()).toEqual(refused(EVIDENCE_PARKED));
    setLoop({ phase: "ci" });
    expect(await call()).toEqual(refused(EVIDENCE_IN_CI));
    expect(reads).toBe(0);
    setLoop();
    await call();
    expect(reads).toBe(1);
  });

  it("reads the loop inside the clone's queue, not before it", async () => {
    await committed();
    const moved = (over: Partial<RunLoop>) =>
      make({
        now: () => clock,
        inClone: async (_c, fn) => {
          setLoop(over);
          return fn();
        },
      });
    // each call starts from a working loop, which only the queue's own hook then moves
    const call = (ts: McTool[]) => {
      setLoop();
      return tool("report_evidence", ts).call(CTX, { note: "done" });
    };
    expect(await call(moved({ phase: "ci" }))).toEqual(refused(EVIDENCE_IN_CI));
    expect(await call(moved({ phase: "parked" }))).toEqual(refused(EVIDENCE_PARKED));
    expect(await call(moved({ ciFailedSha: head() }))).toEqual(refused(EVIDENCE_NO_COMMIT));
    expect(store.evidenceCount(RUN)).toBe(0);
  });

  it("does not unpark when a budget hold lands while git status is pending", async () => {
    await committed();
    let statusReads = 0;
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = make({
      now: () => clock,
      git: async (cwd, args, common, options) => {
        if (cwd === wt && args[0] === "status") {
          statusReads++;
          await pending;
        }
        return crewGit(cwd, args, common, options);
      },
    });
    setLoop({ phase: "parked", parked: { kind: "review", reason: "waiting", ended: false } });
    const reporting = tool("report_evidence", delayed).call(CTX, { note: "fixed" });
    await vi.waitFor(() => expect(statusReads).toBe(1));
    setLoop({ phase: "parked", parked: { kind: "budget", reason: "held", ended: false } });
    release();

    expect(await reporting).toEqual(refused(EVIDENCE_PARKED));
    expect(store.latestEvidence(RUN)).toBeNull();
    expect(store.run(RUN)?.loop).toMatchObject({
      phase: "parked",
      parked: { kind: "budget", reason: "held", ended: false },
    });
  });

  it("refuses a report with no commit since the last one, and takes it after a new one", async () => {
    expect(await report("done")).toEqual(refused(EVIDENCE_NO_COMMIT));
    await committed();
    expect(await report("one")).toEqual({ text: EVIDENCE_RECORDED });
    clock += 1000;
    expect(await report("two")).toEqual(refused(EVIDENCE_NO_COMMIT));
    await committed("apps/b.ts");
    expect(await report("two")).toEqual({ text: EVIDENCE_RECORDED });
    expect(store.evidenceCount(RUN)).toBe(2);
  });

  it("refuses the sha CI last failed on, and takes a newer commit", async () => {
    const failed = await committed();
    setLoop({ ciFailedSha: failed });
    expect(await report("again")).toEqual(refused(EVIDENCE_NO_COMMIT));
    await committed("apps/b.ts");
    expect(await report("fixed")).toEqual({ text: EVIDENCE_RECORDED });
  });

  it("takes a note that starts with Ruling: with no new commit, even on the failed sha", async () => {
    const failed = await committed();
    setLoop({ ciFailedSha: failed });
    expect(await report("Ruling: the failure is a flake; no change needed")).toEqual({
      text: EVIDENCE_RECORDED,
    });
    expect(await report("Ruling: still no change")).toEqual({ text: EVIDENCE_RECORDED });
    expect(store.evidenceCount(RUN)).toBe(2);
  });

  it("accepts a plain reply to a blocking RETRO finding without a new commit", async () => {
    const sha = await reviewedHead();
    const review = startReview(sha);
    expect(claimFix(review)).toBe(true);
    expect(await report("1. This case is intentionally unsupported.")).toEqual({
      text: EVIDENCE_RECORDED,
    });
  });

  it("refuses a reply when the blocking review is from a stale epoch", async () => {
    const sha = await reviewedHead();
    startReview(sha, { epoch: 1 });
    setLoop({ phase: "review", epoch: 0, reportedEvidenceId: 1 });
    expect(await report("Ruling: this old finding no longer applies.")).toEqual(
      refused(EVIDENCE_NO_COMMIT),
    );
  });

  it("refuses a reply after a later clean review", async () => {
    const sha = await reviewedHead();
    startReview(sha);
    startReview(sha, { attempt: 2, blocking: false });
    expect(await report("The earlier finding is not applicable.")).toEqual(
      refused(EVIDENCE_NO_COMMIT),
    );
  });

  it("refuses a reply while the current review is running", async () => {
    const sha = await reviewedHead();
    startReview(sha);
    startReview(sha, { attempt: 2, running: true });
    expect(await report("The earlier finding is not applicable.")).toEqual(
      refused(EVIDENCE_NO_COMMIT),
    );
  });

  it("refuses a repeated reply to the same review", async () => {
    const sha = await reviewedHead();
    const review = startReview(sha);
    expect(claimFix(review)).toBe(true);
    setLoop({ phase: "review", reportedEvidenceId: 1, reviewReplyTo: review });
    expect(await report("I already answered this finding.")).toEqual(refused(EVIDENCE_NO_COMMIT));
  });

  it("refuses a reply while earlier evidence is unprocessed", async () => {
    const sha = await reviewedHead();
    const review = startReview(sha);
    expect(claimFix(review)).toBe(true);
    store.addEvidence(RUN, "An earlier report has not been processed.", clock);
    expect(await report("I am replying to the finding.")).toEqual(refused(EVIDENCE_NO_COMMIT));
  });

  it("records the note, answers EVIDENCE_RECORDED, tells the supervisor and the bus", async () => {
    await committed();
    emitted.length = 0;
    clock += 1000;
    expect(await report("Fixed the race.\n\nDeploy: restart the hub.")).toEqual({
      text: "Recorded. Mission Control is pushing and will message you when CI has run.",
    });
    expect(store.latestEvidence(RUN)).toEqual({
      id: expect.any(Number),
      runId: RUN,
      note: "Fixed the race.\n\nDeploy: restart the hub.",
      at: clock,
      tests: [],
      testsAdded: [],
      doneWhen: [],
    });
    expect(told).toEqual([["guido-1", RUN]]);
    expect(emitted).toContain("agents");
  });

  it("lets the run's own issue through, and refuses a mention, another issue and an unclosed block", async () => {
    const own = "Fixes the race (see #42 and `code`).";
    await committed();
    for (const bad of [
      "thanks @octocat",
      "Closes #12",
      "see o/other#3",
      "```\nnever closed",
      "write &sol; here",
    ]) {
      const r = await report(bad);
      expect(r.isError, bad).toBe(true);
      expect(r.text, bad).toMatch(/^Not recorded: the note is posted to GitHub /);
    }
    expect(store.evidenceCount(RUN)).toBe(0);
    expect(told).toEqual([]);
    expect(await report(own)).toEqual({ text: EVIDENCE_RECORDED });
  });

  it("names what it found in the note's text", async () => {
    await committed();
    expect((await report("thanks @octocat")).text).toBe(evidenceTextText("@octocat"));
  });

  it("refuses a secret in the note without repeating it, and records a guard hit", async () => {
    await committed();
    const r = await report(`token: ${TOKEN}`);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("evidence note:1 looks like a");
    expect(r.text).not.toContain(TOKEN);
    expect(store.guardHits(0).map((h) => [h.agentId, h.runId, h.rule, h.text])).toEqual([
      ["guido-1", RUN, "secret", "No secrets in a push: mc report_evidence"],
    ]);
    const local = make({ now: () => clock, knownSecrets: async () => [LOCAL] });
    const k = await tool("report_evidence", local).call(CTX, { note: `key ${LOCAL}` });
    expect(k.isError).toBe(true);
    expect(k.text).not.toContain(LOCAL);
    expect(store.evidenceCount(RUN)).toBe(0);
  });

  it("validates its arguments", async () => {
    for (const bad of [undefined, "", "   ", "x".repeat(4001), "a\0b"]) {
      const r = await report(bad);
      expect(r.isError, String(bad)).toBe(true);
      expect(r.text).toMatch(/^Invalid arguments: /);
    }
    const extra = await tool("report_evidence", ev).call(CTX, { note: "ok", more: 1 });
    expect(extra.text).toMatch(/^Invalid arguments: /);
    await committed();
    expect(await report("x".repeat(4000))).toEqual({ text: EVIDENCE_RECORDED });
  });
});

// ---------- Plan 7b-1 ticket 02: report_findings ----------

describe("report_findings", () => {
  const REVIEW_RUN = "retro:20261020T115500Z";
  const AUTHOR_SHA = "a".repeat(40);
  let told: [string, string][];
  let rt: McTool[];
  let reviewId: number;
  const ctx: McToolContext = { seatId: "retro", runId: REVIEW_RUN };
  const finding = (over: Record<string, unknown> = {}) => ({
    severity: "Critical",
    file: "apps/a.ts",
    line: 3,
    summary: "wrong",
    scenario: "when x, y",
    fix: "change z",
    ...over,
  });
  const failing = { spec: "fail", quality: "pass" };
  const passing = { spec: "pass", quality: "pass" };
  const args = (over: Record<string, unknown> = {}) => ({
    verdict: failing,
    summary: "two sentences",
    findings: [finding(), finding({ severity: "Minor", line: 0 })],
    ...over,
  });
  const report = (a: unknown = args(), c: McToolContext = ctx) =>
    tool("report_findings", rt).call(c, a);
  const refused = (text: string) => ({ text, isError: true });
  const stored = () => store.findingsOf(reviewId).length;
  /** The retro seat's live run `runId`, performing review `id` (review_id is set at insert only). */
  const reviewRun = (runId: string, id: number | null, over: Partial<Run> = {}) => {
    store.upsertRun(run({ id: runId, agentId: "retro", ticket: null, reviewId: id, ...over }));
    store.setSeatSession({
      seatId: "retro",
      runId,
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    return { seatId: "retro", runId };
  };

  beforeEach(() => {
    told = [];
    rt = make({ onFindings: (s, r) => told.push([s, r]) });
    const id = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: AUTHOR_SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW,
    });
    if (id === null) throw new Error("no review");
    reviewId = id;
    store.setReviewState(id, ["queued"], "running", { at: NOW, runId: REVIEW_RUN });
    reviewRun(REVIEW_RUN, id);
  });

  it("is offered to scratch seats only, and says what the schema requires", () => {
    const t = tool("report_findings", rt);
    expect(t.modes).toEqual(["scratch"]);
    expect(t.inputSchema).toMatchObject({
      required: ["verdict", "summary", "findings"],
      additionalProperties: false,
    });
  });

  it("describes every structured review field to MCP clients", () => {
    expect(tool("report_findings", rt).inputSchema).toMatchObject({
      properties: {
        checked: {
          items: {
            properties: {
              check: { type: "string" },
              result: { type: "string" },
              note: { type: "string" },
            },
            required: ["check", "result"],
            additionalProperties: false,
          },
        },
        tests: {
          items: {
            properties: { command: { type: "string" }, failed: { type: "integer", minimum: 0 } },
            required: ["command", "passed", "failed", "skipped", "duration"],
            additionalProperties: false,
          },
        },
        resolutions: {
          items: {
            properties: {
              findingRef: {
                properties: {
                  reviewId: { type: "integer", minimum: 1 },
                  pos: { type: "integer", minimum: 0 },
                },
                required: ["pos"],
                additionalProperties: false,
              },
              outcome: { type: "string" },
            },
            required: ["findingRef", "outcome"],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it("records structured checks, test runs, categories and prior-round resolutions", async () => {
    const first = await report(
      args({
        checked: [
          { check: "new-behaviour-tests", result: "pass", note: "covered" },
          { check: "design", result: "pass", note: "hud-shot:design-pair" },
        ],
        tests: [
          {
            command: "pnpm -s vitest run a.test.ts",
            passed: 2,
            failed: 0,
            skipped: 1,
            duration: 30,
          },
        ],
        findings: [finding({ category: "correctness" })],
      }),
    );
    expect(first).toEqual({ text: FINDINGS_RECORDED });
    const second = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: "b".repeat(40),
      epoch: 0,
      attempt: 2,
      round: 2,
      at: NOW + 1,
    }) as number;
    store.setReviewState(second, ["queued"], "running", { at: NOW + 1, runId: "retro:round-2" });
    reviewRun("retro:round-2", second);
    expect(
      await report(
        args({
          verdict: passing,
          findings: [],
          resolutions: [{ findingRef: { reviewId, pos: 0 }, outcome: "fixed" }],
        }),
        { seatId: "retro", runId: "retro:round-2" },
      ),
    ).toEqual({ text: FINDINGS_RECORDED });
    expect(store.reviewChecks(reviewId)).toEqual([
      { check: "design", result: "pass", note: "hud-shot:design-pair" },
      { check: "new-behaviour-tests", result: "pass", note: "covered" },
    ]);
    expect(store.reviewTests(reviewId)).toEqual([
      {
        command: "pnpm -s vitest run a.test.ts",
        file: null,
        passed: 2,
        failed: 0,
        skipped: 1,
        duration: 30,
      },
    ]);
    expect(store.findingsOf(reviewId)[0]).toMatchObject({ category: "correctness" });
    expect(store.reviewResolutions(second)).toEqual([{ reviewId, pos: 0, outcome: "fixed" }]);
    expect(store.findingsOf(reviewId)[0]).toMatchObject({
      resolution: "fixed",
      resolvedReviewId: second,
    });
  });

  it("validates structured report fields and only accepts prior-round resolutions", async () => {
    expect((await report(args({ checked: [{ check: "nope", result: "pass" }] }))).isError).toBe(
      true,
    );
    expect(
      (
        await report(
          args({ tests: [{ command: "x", passed: -1, failed: 0, skipped: 0, duration: 1 }] }),
        )
      ).isError,
    ).toBe(true);
    expect((await report(args({ findings: [finding({ category: "nope" })] }))).isError).toBe(true);
    expect(
      (
        await report(
          args({ resolutions: [{ findingRef: { reviewId, pos: 0 }, outcome: "fixed" }] }),
        )
      ).isError,
    ).toBe(true);
  });

  it("stores a resolution given by position alone against the previous review", async () => {
    expect(await report()).toEqual({ text: FINDINGS_RECORDED });
    const second = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: "b".repeat(40),
      epoch: 0,
      attempt: 2,
      round: 2,
      at: NOW + 1,
    }) as number;
    store.setReviewState(second, ["queued"], "running", { at: NOW + 1, runId: "retro:round-2" });
    const roundTwo = reviewRun("retro:round-2", second);
    const resolution = { findingRef: { pos: 0 }, outcome: "fixed" } as const;
    expect(
      await report(args({ verdict: passing, findings: [], resolutions: [resolution] }), roundTwo),
    ).toEqual({ text: FINDINGS_RECORDED });
    expect(store.reviewResolutions(second)).toEqual([{ reviewId, pos: 0, outcome: "fixed" }]);
    expect(store.findingsOf(reviewId)[0]).toMatchObject({
      resolution: "fixed",
      resolvedReviewId: second,
    });
  });

  it("binds a positional resolution to the latest reported review of the same epoch", async () => {
    const mk = (epoch: number, round: number, at: number) =>
      store.requestReview({
        authorRunId: RUN,
        repoId: "mc",
        seatId: "retro",
        prNumber: 9,
        sha: String(at).padEnd(40, "c"),
        epoch,
        attempt: 2,
        round,
        at,
      }) as number;
    // the epoch-0 round-1 review is the one `reviewId` already holds; a later epoch repeats round 1
    expect(await report()).toEqual({ text: FINDINGS_RECORDED });
    const later = mk(1, 1, NOW + 1);
    store.setReviewState(later, ["queued"], "running", { at: NOW + 1, runId: "retro:e1r1" });
    expect(await report(args(), reviewRun("retro:e1r1", later))).toEqual({
      text: FINDINGS_RECORDED,
    });
    const second = mk(1, 2, NOW + 2);
    store.setReviewState(second, ["queued"], "running", { at: NOW + 2, runId: "retro:e1r2" });
    expect(
      await report(
        args({
          verdict: passing,
          findings: [],
          resolutions: [{ findingRef: { pos: 0 }, outcome: "fixed" }],
        }),
        reviewRun("retro:e1r2", second),
      ),
    ).toEqual({ text: FINDINGS_RECORDED });
    expect(store.reviewResolutions(second)).toEqual([
      { reviewId: later, pos: 0, outcome: "fixed" },
    ]);
  });

  it("rejects a positional and an explicit reference to the same prior finding", async () => {
    expect(await report()).toEqual({ text: FINDINGS_RECORDED });
    const second = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: "b".repeat(40),
      epoch: 0,
      attempt: 2,
      round: 2,
      at: NOW + 1,
    }) as number;
    store.setReviewState(second, ["queued"], "running", { at: NOW + 1, runId: "retro:round-2" });
    const roundTwo = reviewRun("retro:round-2", second);
    const result = await report(
      args({
        verdict: passing,
        findings: [],
        resolutions: [
          { findingRef: { pos: 0 }, outcome: "fixed" },
          { findingRef: { reviewId, pos: 0 }, outcome: "held" },
        ],
      }),
      roundTwo,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Invalid arguments: resolutions:/);
  });

  it("rejects duplicate prior-round resolution references before storage", async () => {
    expect(await report()).toEqual({ text: FINDINGS_RECORDED });
    const second = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: "b".repeat(40),
      epoch: 0,
      attempt: 2,
      round: 2,
      at: NOW + 1,
    }) as number;
    store.setReviewState(second, ["queued"], "running", { at: NOW + 1, runId: "retro:round-2" });
    const roundTwo = reviewRun("retro:round-2", second);
    const resolution = { findingRef: { reviewId, pos: 0 }, outcome: "fixed" } as const;
    const result = await report(
      args({ verdict: passing, findings: [], resolutions: [resolution, resolution] }),
      roundTwo,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Invalid arguments: resolutions:/);
    expect(store.review(second)?.state).toBe("running");
    expect(store.reviewResolutions(second)).toEqual([]);
  });

  it("answers bad arguments", async () => {
    const r = await report(args({ findings: [finding({ line: -1 })] }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Invalid arguments: /);
    expect((await report({ ...args(), extra: 1 })).text).toMatch(/^Invalid arguments: /);
    expect(stored()).toBe(0);
  });

  it("answers the ended-run text for a run that has ended", async () => {
    reviewRun(REVIEW_RUN, reviewId, { endedAt: NOW, status: "ok" });
    expect(await report()).toEqual(refused(MC_RUN_ENDED));
  });

  it("refuses a run that is not a review", async () => {
    expect(await report(args(), CTX)).toEqual(refused(FINDINGS_NOT_A_REVIEW));
    expect(await report(args(), reviewRun("retro:no-review", 999))).toEqual(
      refused(FINDINGS_NOT_A_REVIEW),
    );
    // a review that names another run
    const other = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: AUTHOR_SHA,
      epoch: 0,
      attempt: 2,
      round: 1,
      at: NOW,
    }) as number;
    store.setReviewState(other, ["queued"], "running", { at: NOW, runId: "someone-else" });
    expect(await report(args(), reviewRun("retro:other", other))).toEqual(
      refused(FINDINGS_NOT_A_REVIEW),
    );
  });

  it("answers already for a reported review and dropped for any other state", async () => {
    store.setReviewState(reviewId, ["running"], "superseded", { at: NOW });
    expect(await report()).toEqual(refused(FINDINGS_DROPPED));
    store.setReviewState(reviewId, ["superseded"], "reported", { at: NOW });
    expect(await report()).toEqual({ text: FINDINGS_ALREADY });
    expect(stored()).toBe(0);
    expect(told).toEqual([]);
  });

  it("names the first finding whose file is not a plain path", async () => {
    const r = await report(args({ findings: [finding(), finding({ file: "a/../b" })] }));
    expect(r).toEqual(refused(findingFileText(2)));
    expect((await report(args({ findings: [finding({ file: "@x/y" })] }))).text).toBe(
      findingFileText(1),
    );
    expect(stored()).toBe(0);
  });

  it("holds a fail verdict to a blocking finding, and a blocking finding to a fail verdict", async () => {
    expect(await report(args({ findings: [finding({ severity: "Minor" })] }))).toEqual(
      refused(FINDINGS_FAIL_NEEDS_BLOCKING),
    );
    expect(await report(args({ verdict: failing, findings: [] }))).toEqual(
      refused(FINDINGS_FAIL_NEEDS_BLOCKING),
    );
    expect(await report(args({ verdict: passing }))).toEqual(refused(FINDINGS_BLOCKING_NEEDS_FAIL));
    expect(stored()).toBe(0);
    expect(store.review(reviewId)?.state).toBe("running");
  });

  it("answers dropped when the review is dropped between the read and the write", async () => {
    const real = store.recordFindings.bind(store);
    store.recordFindings = (id, runId, r) => {
      store.setReviewState(id, ["running"], "superseded", { at: NOW });
      return real(id, runId, r);
    };
    try {
      expect(await report()).toEqual(refused(FINDINGS_DROPPED));
    } finally {
      store.recordFindings = real;
    }
    expect(stored()).toBe(0);
    expect(store.loopEventsOfRun(RUN)).toEqual([]);
    expect(told).toEqual([]);
  });

  it("records findings, an Activity row, a bus change and the supervisor event", async () => {
    const before = emitted.length;
    expect(await report()).toEqual({ text: FINDINGS_RECORDED });
    expect(store.review(reviewId)).toMatchObject({
      state: "reported",
      blocking: 1,
      minor: 1,
      verdict: failing,
    });
    expect(store.findingsOf(reviewId).map((f) => [f.severity, f.state, f.line])).toEqual([
      ["Critical", "open", 3],
      ["Minor", "logged", 0],
    ]);
    expect(store.loopEventsOfRun(RUN)).toEqual([
      {
        key: `${RUN}:review:${reviewId}:reported`,
        runId: RUN,
        text: "RETRO reviewed aaaaaaa: 1 blocking, 1 minor",
        at: NOW,
      },
    ]);
    expect(emitted.slice(before)).toContain("agents");
    expect(told).toEqual([["retro", REVIEW_RUN]]);
  });

  it("records an empty report with passing verdicts", async () => {
    expect(await report(args({ verdict: passing, findings: [] }))).toEqual({
      text: FINDINGS_RECORDED,
    });
    expect(store.review(reviewId)).toMatchObject({ state: "reported", blocking: 0, minor: 0 });
  });

  it("a second call is already recorded", async () => {
    await report();
    expect(await report()).toEqual({ text: FINDINGS_ALREADY });
    expect(stored()).toBe(2);
    expect(store.loopEventsOfRun(RUN)).toHaveLength(1);
    expect(told).toHaveLength(1);
  });
});

// ---------- report_plan ----------

describe("report_plan", () => {
  const FAO_RUN = "fao-1:20261020T115000Z";
  const FAO_CTX: McToolContext = { seatId: "fao-1", runId: FAO_RUN };
  const PLAN = "### Outcome\n\nDo X, then Y.\n\n### Tests\n\n- First, in `a.test.ts`.";
  let ghDir: string;
  let told: [string, string][];
  let pt: McTool[];

  const ghState = (state: Record<string, { code?: number; stdout?: string; stderr?: string }>) =>
    writeFileSync(join(ghDir, "state.json"), JSON.stringify(state));
  const view = (body: string, state = "OPEN") => ({
    "issue view": { stdout: JSON.stringify({ body, state }) },
  });
  const ghCalls = (): GhCall[] => {
    try {
      return readFileSync(join(ghDir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as GhCall);
    } catch {
      return [];
    }
  };
  const plan = (text: unknown = PLAN, ctx: McToolContext = FAO_CTX) =>
    tool("report_plan", pt).call(ctx, { plan: text });
  const refused = (text: string) => ({ text, isError: true });
  const bodyFiles = () => readdirSync(join(dir, "data", "crew")).filter((f) => f.startsWith("pr-"));

  beforeEach(() => {
    ghDir = join(dir, "fakegh");
    mkdirSync(ghDir);
    writeFileSync(join(ghDir, "gh"), FAKE_GH, { mode: 0o755 });
    ghState(view("Do X."));
    const cfg = config();
    cfg.crew?.sessions[0]?.seats.push({
      id: "fao-1",
      role: "FAO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    told = [];
    pt = createMcTools(
      deps({
        config: cfg,
        gh: createGh(join(ghDir, "gh")),
        onPlanned: (s, r) => told.push([s, r]),
      }),
    );
    store.upsertRun(run({ id: FAO_RUN, agentId: "fao-1", branch: null, ticket: "mc#7" }));
    store.setSeatSession({
      seatId: "fao-1",
      runId: FAO_RUN,
      cliSessionId: "cli-2",
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
  });

  it("is eligible for planners; build visibility is granted per run", () => {
    expect(tool("report_plan", pt).modes).toEqual([]);
    expect(tool("report_plan", pt).grantable).toEqual(["read-only"]);
  });

  it("refuses report_plan while away without editing GitHub", async () => {
    store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
    expect(await plan()).toEqual(refused(AWAY_PLAN_REFUSED));
    expect(ghCalls()).toEqual([]);
    expect(told).toEqual([]);
  });

  it("rechecks away after reading the issue and before editing it", async () => {
    const calls: string[][] = [];
    const cfg = config();
    cfg.crew?.sessions[0]?.seats.push({
      id: "fao-1",
      role: "FAO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    const tools = createMcTools(
      deps({
        config: cfg,
        gh: async (args) => {
          calls.push([...args]);
          store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
          return { code: 0, stdout: JSON.stringify({ body: "Do X.", state: "OPEN" }), stderr: "" };
        },
      }),
    );
    expect(await tool("report_plan", tools).call(FAO_CTX, { plan: PLAN })).toEqual(
      refused(AWAY_PLAN_REFUSED),
    );
    expect(calls.some((a) => a[1] === "edit")).toBe(false);
    expect(told).toEqual([]);
  });

  it("appends the plan", async () => {
    expect(await plan()).toEqual({ text: MC_PLAN_WRITTEN });
    const calls = ghCalls();
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([
      ["issue", "view", "7"],
      ["issue", "edit", "7"],
    ]);
    expect(calls[0]?.args).toContain("--repo=o/mc");
    expect(calls[0]?.args).toContain("--json=body,state");
    expect(calls[1]?.args).toContain("--repo=o/mc");
    expect(calls[1]?.body).toBe(
      `Do X.\n\n## Plan\n\n${PLAN}\n\nPlanned by FAO-1 (Mission Control).\n`,
    );
    expect(calls[1]?.mode).toBe("600");
    expect(told).toEqual([["fao-1", FAO_RUN]]);
    expect(store.loopEventsOfRun(FAO_RUN).map((e) => [e.key, e.text])).toEqual([
      [`${FAO_RUN}:plan`, "plan written to mc#7"],
    ]);
    expect(emitted).toContain("agents");
    expect(bodyFiles()).toEqual([]);
  });

  it("lets a build seat record its own plan and continue its run", async () => {
    const runId = "guido:1";
    store.upsertRun(run({ id: runId, agentId: "guido-1", branch: "guido/7", ticket: "mc#7" }));
    store.setSeatSession({
      seatId: "guido-1",
      runId,
      cliSessionId: "cli-build",
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(await plan(PLAN, { seatId: "guido-1", runId })).toEqual({
      text: MC_PLAN_WRITTEN_CONTINUE,
    });
    expect(told).toEqual([]);
    expect(store.run(runId)?.endedAt).toBeNull();
    expect(store.loopEventsOfRun(runId).map((e) => e.text)).toEqual([planWrittenText("mc#7")]);
    expect(await plan(PLAN, { seatId: "guido-1", runId })).toEqual(refused(MC_PLAN_NOT_FAO));
  });

  it("fails closed for a build run that started with a plan", async () => {
    const runId = "guido:planned";
    store.upsertRun(
      run({
        id: runId,
        agentId: "guido-1",
        branch: "guido/7",
        ticket: "mc#7",
        plan: { by: null, at: null, ref: "mc#7" },
      }),
    );
    store.setSeatSession({
      seatId: "guido-1",
      runId,
      cliSessionId: "cli-build",
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(await plan(PLAN, { seatId: "guido-1", runId })).toEqual(refused(MC_PLAN_NOT_FAO));
    expect(ghCalls()).toEqual([]);
  });

  it("refuses profile fields from a build seat", async () => {
    const runId = "guido:profile";
    store.upsertRun(run({ id: runId, agentId: "guido-1", branch: "guido/7", ticket: "mc#7" }));
    store.setSeatSession({
      seatId: "guido-1",
      runId,
      cliSessionId: "cli-build",
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(
      await tool("report_plan", pt).call(
        { seatId: "guido-1", runId },
        { plan: PLAN, profile: "bugfix", profile_reason: "it is a bug" },
      ),
    ).toEqual(refused(MC_PLAN_PROFILE_ONLY));
    expect(store.profileOverride("mc", 7)).toBeNull();
    expect(ghCalls()).toEqual([]);
  });

  it.each(["claude", "codex"] as const)(
    "lists and calls report_plan through MCP for a planless %s build run",
    async (vendor) => {
      const seatId = `${vendor}-guido`;
      const runId = `${vendor}:mcp`;
      const cfg = config();
      if (vendor === "codex")
        cfg.accounts.push({ id: "codex-main", vendor, alertAt: 80, stopAt: 95 });
      cfg.crew?.sessions[0]?.seats.push({
        id: seatId,
        role: "GUIDO",
        accountId: vendor === "codex" ? "codex-main" : "claude-main",
        model: "haiku",
        area: ["apps/**"],
      });
      const mcpTools = createMcTools(deps({ config: cfg, gh: createGh(join(ghDir, "gh")) }));
      store.upsertRun(
        run({
          id: runId,
          agentId: seatId,
          branch: `${vendor}/7`,
          ticket: `mc#${vendor === "claude" ? 7 : 8}`,
          vendor,
        }),
      );
      store.setSeatSession({
        seatId,
        runId,
        cliSessionId: "cli-build",
        state: "running",
        reason: null,
        worktree: null,
        updatedAt: NOW,
      });
      const tokens = new RunTokens();
      const token = tokens.issue(seatId, runId);
      const app = buildApp({
        config: cfg,
        store,
        bus,
        tokens,
        seatMode: (id) => crewSeatMode(cfg, id),
        runGrants: (who) => runSeatGrants(cfg, store, who),
        mcpTools: () => mcpTools,
      });
      await app.ready();
      const rpc = (method: string, params?: object) =>
        app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${token}` },
          payload: { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) },
        });
      try {
        expect(
          ((await rpc("tools/list")).json().result.tools as { name: string }[]).map((t) => t.name),
        ).toContain("report_plan");
        expect(
          (await rpc("tools/call", { name: "report_plan", arguments: { plan: PLAN } })).json()
            .result.content[0].text,
        ).toBe(MC_PLAN_WRITTEN_CONTINUE);
        expect(
          ((await rpc("tools/list")).json().result.tools as { name: string }[]).map((t) => t.name),
        ).not.toContain("report_plan");
      } finally {
        await app.close();
      }
    },
  );

  it("records the plan landing as the planner to CAPCOM when the session has no FLIGHT seat", async () => {
    await plan();
    expect(store.comms(0)).toEqual([
      {
        at: NOW,
        from: "fao-1",
        to: "CAPCOM",
        ticket: "mc#7",
        text: planWrittenText("mc#7"),
      },
    ]);
  });

  it("records it to the session's FLIGHT seat, skipping a retiring one", async () => {
    const cfg = config();
    cfg.crew?.sessions[0]?.seats.push(
      { id: "fao-1", role: "FAO", accountId: "claude-main", model: "haiku", area: [] },
      {
        id: "flight-0",
        role: "FLIGHT",
        accountId: "claude-main",
        model: "haiku",
        area: [],
        retiring: true,
      },
      { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "haiku", area: [] },
    );
    const withFlight = createMcTools(deps({ config: cfg, gh: createGh(join(ghDir, "gh")) }));
    await tool("report_plan", withFlight).call(FAO_CTX, { plan: PLAN });
    expect(store.comms(0).map((c) => [c.from, c.to, c.ticket])).toEqual([
      ["fao-1", "flight-1", "mc#7"],
    ]);
  });

  it("records nothing when the plan is refused", async () => {
    await plan("ask @someone");
    expect(store.comms(0)).toEqual([]);
  });

  it("starts the body with the plan when the ticket body is blank", async () => {
    ghState(view("  \n"));
    await plan();
    expect(ghCalls()[1]?.body).toBe(`## Plan\n\n${PLAN}\n\nPlanned by FAO-1 (Mission Control).\n`);
  });

  it("refuses a mention, another issue, a secret", async () => {
    const mention = await plan("ask @someone");
    expect(mention.isError).toBe(true);
    expect(mention.text).toMatch(/^Not written: the plan is posted to GitHub and must not notify/);
    expect((await plan("see #99")).text).toMatch(/^Not written: the plan is posted to GitHub/);
    expect(ghCalls()).toEqual([]);
    expect(store.guardHits(0)).toEqual([]);
    const secret = await plan(`key ${TOKEN}`);
    expect(secret.isError).toBe(true);
    expect(secret.text).toContain("plan:1 looks like a GitHub token");
    expect(secret.text).not.toContain(TOKEN);
    expect(ghCalls()).toEqual([]);
    expect(store.guardHits(0).map((h) => [h.agentId, h.runId, h.rule])).toEqual([
      ["fao-1", FAO_RUN, "secret"],
    ]);
    expect(told).toEqual([]);
  });

  describe("the plan is checked", () => {
    const DONE = "Do X.\n\n## Done when\n\n- A works.\n- B works.\n";
    let checkout: string;
    beforeEach(() => {
      checkout = join(dir, "planner-checkout");
      mkdirSync(join(checkout, "src"), { recursive: true });
      writeFileSync(join(checkout, "src", "a.ts"), "");
      store.setSeatSession({
        seatId: "fao-1",
        runId: FAO_RUN,
        cliSessionId: "cli-2",
        state: "running",
        reason: null,
        worktree: checkout,
        updatedAt: NOW,
      });
      ghState(view(DONE));
    });
    const TWO = "### Tests\n\n- A: `a.test.ts` first.\n- B: `b.test.ts` first.";

    it("refuses a plan without ### Tests", async () => {
      expect(await plan("### Outcome\n\nDo X.")).toEqual(refused(MC_PLAN_NO_TESTS));
      expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
      expect(told).toEqual([]);
    });

    it("refuses fewer tests than Done when items", async () => {
      expect(await plan("### Tests\n\n- A: `a.test.ts` first.")).toEqual(
        refused(planFewTestsText(1, 2)),
      );
      expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
    });

    it("refuses a path that is not in the checkout, listing five", async () => {
      const r = await plan(
        `${TWO}\n\nEdit \`src/a.ts\`, \`src/m1.ts\`, \`src/m2.ts\`, \`src/m3.ts\`, \`src/m4.ts\`, \`src/m5.ts\`, \`src/m6.ts\`.`,
      );
      expect(r).toEqual(
        refused(
          planMissingPathsText([
            "src/m1.ts",
            "src/m2.ts",
            "src/m3.ts",
            "src/m4.ts",
            "src/m5.ts",
            "src/m6.ts",
          ]),
        ),
      );
      expect(r.text).not.toContain("src/m6.ts");
      expect(r.text).toContain("and 1 more");
      expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
    });

    it("counts only top-level Done when and Tests items", async () => {
      ghState(view("Do X.\n\n## Done when\n\n- A works.\n  - detail.\n- B works.\n"));
      expect(await plan(TWO)).toEqual({ text: MC_PLAN_WRITTEN });
      ghState(view(DONE));
      expect(await plan("### Tests\n\n- A: `a.test.ts`.\n  - more.\n  - even more.")).toEqual(
        refused(planFewTestsText(1, 2)),
      );
    });

    it("ignores bullets in a fenced block under Done when", async () => {
      ghState(view("Do X.\n\n## Done when\n\n- A works.\n- B works.\n\n```\n- x\n- y\n- z\n```\n"));
      expect(await plan(TWO)).toEqual({ text: MC_PLAN_WRITTEN });
    });

    it("ignores paths in a fenced block and strips :line suffixes", async () => {
      expect(
        await plan(`${TWO}\n\n\`\`\`\nsee \`src/nope.ts\`\n\`\`\`\nChange \`src/a.ts:3-9\`.`),
      ).toEqual({ text: MC_PLAN_WRITTEN });
    });

    it("accepts a missing path the same line says it creates", async () => {
      expect(await plan(`${TWO}\n\nCreate \`src/b.ts\`. Change \`src/a.ts\`.`)).toEqual({
        text: MC_PLAN_WRITTEN,
      });
      expect(await plan(`${TWO}\n\nNew file \`src/c.ts\`.`)).toEqual({ text: MC_PLAN_WRITTEN });
      expect(await plan(`${TWO}\n\n- Create: \`src/b.ts\`, \`src/c.ts\`.`)).toEqual({
        text: MC_PLAN_WRITTEN,
      });
      expect(await plan(`${TWO}\n\n- **Create** \`src/d.ts\``)).toEqual({ text: MC_PLAN_WRITTEN });
    });

    it("accepts a later mention of a path an earlier line creates", async () => {
      expect(
        await plan(`${TWO}\n\n- Create \`src/b.ts\`.\n- Export \`src/b.ts\` from \`src/a.ts\`.`),
      ).toEqual({ text: MC_PLAN_WRITTEN });
    });

    it("checks a path after a long run of code spans without hanging", async () => {
      expect(
        await plan(`${TWO}\n\nCreate ${"`a` ".repeat(40)}then change \`src/missing.ts\`.`),
      ).toEqual(refused(planMissingPathsText(["src/missing.ts"])));
    });

    it("still checks a path after a create cue that is not the one created", async () => {
      expect(await plan(`${TWO}\n\nCreate \`src/b.ts\` to call \`src/missing.ts\`.`)).toEqual(
        refused(planMissingPathsText(["src/missing.ts"])),
      );
    });

    it("does not skip a path because the line says new elsewhere", async () => {
      expect(await plan(`${TWO}\n\nAdd a new case to \`src/wrong.ts\`.`)).toEqual(
        refused(planMissingPathsText(["src/wrong.ts"])),
      );
    });

    it("refuses a path that leaves the checkout, even on a create line", async () => {
      for (const bad of ["../../x.ts", "/etc/x.conf", "~/x.sh", "src/../../x.ts"]) {
        expect(await plan(`${TWO}\n\nCreate \`${bad}\`.`)).toEqual(
          refused(planUnsafePathsText([bad])),
        );
      }
    });

    it("checks a path with a :line suffix without the suffix", async () => {
      expect(await plan(`${TWO}\n\nChange \`src/missing.ts:12\`.`)).toEqual(
        refused(planMissingPathsText(["src/missing.ts"])),
      );
    });

    it("skips the path check when the seat session has no worktree", async () => {
      store.setSeatSession({
        seatId: "fao-1",
        runId: FAO_RUN,
        cliSessionId: "cli-2",
        state: "running",
        reason: null,
        worktree: null,
        updatedAt: NOW,
      });
      expect(await plan(`${TWO}\n\nChange \`src/missing.ts\`.`)).toEqual({
        text: MC_PLAN_WRITTEN,
      });
    });

    it("writes a complete plan", async () => {
      expect(await plan(`${TWO}\n\nChange \`src/a.ts\`.`)).toEqual({ text: MC_PLAN_WRITTEN });
      expect(told).toEqual([["fao-1", FAO_RUN]]);
    });
  });

  it("refuses a plan that ends inside an unclosed code block", async () => {
    const r = await plan("```ts\nlet a");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unclosed code or HTML block");
    expect(ghCalls()).toEqual([]);
  });

  it("already planned", async () => {
    ghState(view("Do X.\n\n## Plan\n\nold\n"));
    expect(await plan()).toEqual(refused(MC_PLAN_ALREADY));
    expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
    expect(told).toEqual([]);
  });

  it("closed", async () => {
    ghState(view("Do X.", "CLOSED"));
    expect(await plan()).toEqual(refused(MC_PLAN_ISSUE_CLOSED));
    expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
  });

  it("body ends unclosed", async () => {
    ghState(view("Do X.\n\n```ts\nlet a"));
    expect(await plan()).toEqual(refused(MC_PLAN_BODY_UNCLOSED));
    expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
  });

  it("gh view fails", async () => {
    ghState({ "issue view": { code: 1, stderr: "boom" } });
    expect(await plan()).toEqual(refused(MC_PLAN_GH_FAILED));
    expect(logs.some((l) => l.includes("issue view"))).toBe(true);
    ghState({ "issue view": { stdout: "not json" } });
    expect(await plan()).toEqual(refused(MC_PLAN_GH_FAILED));
    expect(told).toEqual([]);
  });

  it("gh edit fails", async () => {
    ghState({ ...view("Do X."), "issue edit": { code: 1, stderr: "nope" } });
    expect(await plan()).toEqual(refused(MC_PLAN_GH_FAILED));
    expect(told).toEqual([]);
    expect(store.loopEventsOfRun(FAO_RUN)).toEqual([]);
    expect(bodyFiles()).toEqual([]);
    // the seat may retry
    ghState(view("Do X."));
    expect(await plan()).toEqual({ text: MC_PLAN_WRITTEN });
  });

  it("not a planner or build seat", async () => {
    store.upsertRun(run({ id: "retro:1", agentId: "retro", branch: null, ticket: "mc#7" }));
    store.setSeatSession({
      seatId: "retro",
      runId: "retro:1",
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(await plan(PLAN, { seatId: "retro", runId: "retro:1" })).toEqual(
      refused(MC_PLAN_NOT_FAO),
    );
    expect(ghCalls()).toEqual([]);
  });

  it("answers the ended-run text for a run that has ended", async () => {
    store.upsertRun(
      run({ id: FAO_RUN, agentId: "fao-1", branch: null, ticket: "mc#7", endedAt: NOW }),
    );
    expect(await plan()).toEqual(refused(MC_RUN_ENDED));
    expect(ghCalls()).toEqual([]);
  });

  it("too long", async () => {
    ghState(view("b".repeat(15_000)));
    const overhead = 15_000 + 2 + "## Plan\n\n".length + 2 + planByLine("FAO-1").length + 1;
    const tests = "### Tests\n\n- t\n\n";
    expect(await plan(tests + "p".repeat(6000 - tests.length))).toEqual(
      refused(planTooLongText(TICKET_BODY_MAX, TICKET_BODY_MAX - overhead)),
    );
    expect(ghCalls().map((c) => c.args[1])).toEqual(["view"]);
    // a plan of exactly that room fits
    expect((await plan(tests + "p".repeat(TICKET_BODY_MAX - overhead - tests.length))).text).toBe(
      MC_PLAN_WRITTEN,
    );
  });

  it("says there is no room when the ticket alone is too long", async () => {
    ghState(view("b".repeat(TICKET_BODY_MAX)));
    expect(await plan()).toEqual(refused(MC_PLAN_NO_ROOM));
  });

  const planWith = (over: Record<string, unknown>) =>
    tool("report_plan", pt).call(FAO_CTX, { plan: PLAN, ...over });

  it("stores the planner's profile choice with its reason, after the plan is written", async () => {
    expect(await planWith({ profile: "bugfix", profile_reason: "it is a bug" })).toEqual({
      text: MC_PLAN_WRITTEN,
    });
    expect(store.profileOverride("mc", 7)).toEqual({
      profile: "bugfix",
      reason: "it is a bug",
      by: "planner",
    });
  });

  it("stores no choice when the plan is refused", async () => {
    ghState(view("Do X.", "CLOSED"));
    await planWith({ profile: "bugfix", profile_reason: "it is a bug" });
    expect(store.profileOverride("mc", 7)).toBeNull();
  });

  it("refuses an unknown profile before gh is called", async () => {
    const r = await planWith({ profile: "zzz", profile_reason: "r" });
    expect(r).toEqual(
      refused(
        planUnknownProfileText(
          "zzz",
          DEFAULT_PROFILES.map((p) => p.name),
        ),
      ),
    );
    expect(ghCalls()).toEqual([]);
    expect(store.profileOverride("mc", 7)).toBeNull();
  });

  it("refuses a profile when the profiles file cannot be read, before gh is called", async () => {
    const cfg = config();
    cfg.crew?.sessions[0]?.seats.push({
      id: "fao-1",
      role: "FAO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    pt = createMcTools(
      deps({
        config: cfg,
        gh: createGh(join(ghDir, "gh")),
        profiles: () => new ProfilesError("boom"),
      }),
    );
    expect(await planWith({ profile: "bugfix", profile_reason: "r" })).toEqual(
      refused(planNoProfilesText("boom")),
    );
    expect(ghCalls()).toEqual([]);
  });

  it("takes a profile and its reason together or not at all", async () => {
    for (const over of [{ profile: "bugfix" }, { profile_reason: "r" }]) {
      expect(await planWith(over)).toEqual(refused(`${MC_BAD_ARGS}${PROFILE_PAIR_TEXT}`));
    }
    expect(ghCalls()).toEqual([]);
  });

  it("refuses arguments it does not take", async () => {
    expect((await plan("")).isError).toBe(true);
    expect((await plan("x".repeat(MC_PLAN_MAX + 1))).isError).toBe(true);
    expect((await tool("report_plan", pt).call(FAO_CTX, { plan: "ok", more: 1 })).isError).toBe(
      true,
    );
    expect(ghCalls()).toEqual([]);
  });
});

describe("commit: a merge of main in progress", () => {
  let tip: string;
  let mainSha: string;
  const mergeHead = (): string | null => {
    try {
      return git(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD").trim();
    } catch {
      return null;
    }
  };
  const parents = (): string[] =>
    git(wt, "rev-list", "--parents", "-n1", "HEAD").trim().split(" ").slice(1);
  const merging = (mainMerge: RunLoop["mainMerge"]) =>
    store.setRunLoop(RUN, { ...NEW_LOOP, phase: "working", mainMerge });
  const startMerge = () => {
    try {
      git(wt, "merge", "--no-ff", "--no-commit", mainSha);
    } catch {
      // the conflict is the point
    }
  };

  /** The branch and main both edit apps/a.ts; main also edits docs/c.md. The merge conflicts. */
  beforeEach(() => {
    write("apps/a.ts", "branch\n");
    git(wt, "commit", "-qam", "feat: branch");
    tip = head();
    store.addRunCommit({ runId: RUN, repoId: "mc", branch: BRANCH, sha: tip, at: NOW });
    writeFileSync(join(clone, "apps/a.ts"), "main\n");
    writeFileSync(join(clone, "docs/c.md"), "c from main\n");
    git(clone, "commit", "-qam", "main moves");
    mainSha = git(clone, "rev-parse", "main").trim();
    startMerge();
    merging({ mainSha, files: ["apps/a.ts"] });
  });

  it("commits the resolution with both parents; main's docs/c.md needs no area", async () => {
    write("apps/a.ts", "both\n");
    const r = await commit("merge: main into the branch");
    expect(r.text).toMatch(/^Committed /);
    expect(parents()).toEqual([tip, mainSha]);
    expect(readFileSync(join(wt, "docs/c.md"), "utf8")).toBe("c from main\n");
    expect(mergeHead()).toBeNull();
    expect(store.strays()).toEqual([]);
    expect(store.branchCommits("mc", BRANCH).has(head())).toBe(true);
  });

  it("refuses an outside path that differs from main's, and keeps the merge", async () => {
    write("apps/a.ts", "both\n");
    write("docs/c.md", "mine\n");
    const r = await commit("merge: main into the branch");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("docs/c.md");
    expect(r.text).toContain(REVERT);
    expect(mergeHead()).toBe(mainSha);
    // putting main's version back lets it through
    write("docs/c.md", "c from main\n");
    expect((await commit("merge: main into the branch")).text).toMatch(/^Committed /);
    expect(parents()).toEqual([tip, mainSha]);
  });

  it("refuses conflict markers left in a file, and keeps the merge", async () => {
    const r = await commit("merge: main into the branch");
    expect(r).toEqual({ text: commitMarkersText(["apps/a.ts"]), isError: true });
    expect(mergeHead()).toBe(mainSha);
    expect(head()).toBe(tip);
  });

  it("refuses a path still unmerged (one the commit tool never stages)", async () => {
    git(wt, "merge", "--abort");
    mkdirSync(join(wt, ".pnpm-store"), { recursive: true });
    writeFileSync(join(wt, ".pnpm-store/x"), "branch\n");
    git(wt, "add", "-f", ".pnpm-store/x");
    git(wt, "commit", "-qm", "branch store");
    tip = head();
    mkdirSync(join(clone, ".pnpm-store"), { recursive: true });
    writeFileSync(join(clone, ".pnpm-store/x"), "main\n");
    git(clone, "add", "-f", ".pnpm-store/x");
    git(clone, "commit", "-qm", "main store");
    mainSha = git(clone, "rev-parse", "main").trim();
    startMerge();
    merging({ mainSha, files: [] });
    write("apps/a.ts", "both\n");
    expect(await commit("merge: main into the branch")).toEqual({
      text: commitUnresolvedText([".pnpm-store/x"]),
      isError: true,
    });
    expect(mergeHead()).toBe(mainSha);
  });

  it("refuses a merge Mission Control did not start: another sha, or none recorded", async () => {
    write("apps/a.ts", "both\n");
    for (const mainMerge of [{ mainSha: "f".repeat(40), files: [] }, null]) {
      merging(mainMerge);
      expect(await commit("merge: main into the branch")).toEqual({
        text: MC_COMMIT_MERGE_UNKNOWN,
        isError: true,
      });
      expect(mergeHead()).toBe(mainSha);
    }
  });
});

it("the gh runner sends structured card edits on stdin without a shell", async () => {
  const payload = JSON.stringify({ labels: ["lane:work", "literal-$(echo-no)"], assignees: [] });
  const result = await createGh(process.execPath)(["-e", "process.stdin.pipe(process.stdout)"], {
    cwd: tmpdir(),
    input: payload,
  });
  expect(result).toMatchObject({ code: 0, stdout: payload });
});

describe("restore_file", () => {
  const ctx = { seatId: "retro", runId: "retro:restore" };
  const restore = (path: string) => tool(MC_TOOL_NAMES.restoreFile).call(ctx, { path });
  const gitState = () => {
    const files: Record<string, { body: Buffer; mtime: number }> = {};
    const scan = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) scan(path);
        else if (item.name.endsWith(".lock")) continue;
        else files[path] = { body: readFileSync(path), mtime: statSync(path).mtimeMs };
      }
    };
    scan(join(clone, ".git"));
    return {
      index: readFileSync(git(wt, "rev-parse", "--git-path", "index").trim()),
      refs: git(wt, "for-each-ref"),
      pointer: readFileSync(join(wt, ".git")),
      files,
    };
  };
  let sha: string;
  let cfg: CcConfig;
  beforeEach(() => {
    cfg = config();
    const seat = cfg.crew?.sessions[0]?.seats.find((s) => s.id === ctx.seatId);
    if (!seat) throw new Error("no review seat");
    seat.mode = "scratch";
    tools = make({
      config: cfg,
      restoreSandbox: async ({ cwd, args, input }) => {
        execFileSync(process.execPath, args, { cwd, input, stdio: ["pipe", "pipe", "pipe"] });
      },
    });
    chmodSync(join(wt, "apps/a.ts"), 0o755);
    writeFileSync(join(wt, "apps/a.ts"), Buffer.from([0, 255, 10, 13]));
    git(wt, "add", "apps/a.ts");
    git(wt, "commit", "-qm", "executable binary");
    sha = head();
    const id = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW,
    });
    if (id === null) throw new Error("no review");
    store.setReviewState(id, ["queued"], "running", { at: NOW, runId: ctx.runId });
    store.upsertRun(run({ id: ctx.runId, agentId: ctx.seatId, reviewId: id }));
    const session = store.seatSession("guido-1");
    if (session === null) throw new Error("no seat session");
    store.setSeatSession({
      ...session,
      seatId: ctx.seatId,
      runId: ctx.runId,
    });
  });

  it("restores exact bytes and mode from the review head without changing the index or refs", async () => {
    write("apps/a.ts", "experiment");
    chmodSync(join(wt, "apps/a.ts"), 0o644);
    git(wt, "commit", "-qam", "later head");
    const before = gitState();
    expect((await restore("apps/a.ts")).text).toContain(`review head ${sha}`);
    expect(readFileSync(join(wt, "apps/a.ts"))).toEqual(Buffer.from([0, 255, 10, 13]));
    expect(statSync(join(wt, "apps/a.ts")).mode & 0o777).toBe(0o755);
    chmodSync(join(wt, "README.md"), 0o755);
    expect((await restore("README.md")).isError).toBeUndefined();
    expect(statSync(join(wt, "README.md")).mode & 0o777).toBe(0o644);
    expect(gitState()).toEqual(before);
  });

  it("ignores transient Git lock files while capturing state", () => {
    const lock = join(clone, ".git", "objects", "maintenance.lock");
    writeFileSync(lock, "lock");

    expect(gitState().files[lock]).toBeUndefined();
  });

  it("restores a deleted file and its missing parent", async () => {
    rmSync(join(wt, "apps/a.ts"));
    expect((await restore("apps/a.ts")).isError).toBeUndefined();
    rmSync(join(wt, "apps"), { recursive: true });
    expect((await restore("apps/a.ts")).isError).toBeUndefined();
    expect(readFileSync(join(wt, "apps/a.ts"))).toEqual(Buffer.from([0, 255, 10, 13]));
    expect(statSync(join(wt, "apps/a.ts")).mode & 0o777).toBe(0o755);
  });

  it("refuses scratch storage inside the hub data directory before running a helper", async () => {
    const restoreSandbox = vi.fn();
    const ts = make({ config: cfg, dbPath: join(dir, "mc.sqlite"), restoreSandbox });
    const result = await tool(MC_TOOL_NAMES.restoreFile, ts).call(ctx, { path: "apps/a.ts" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("outside the hub data directory");
    expect(restoreSandbox).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin")(
    "Seatbelt tool restore and delete use the default sandbox runner",
    async () => {
      const ts = make({ config: cfg });
      const call = (path: string) => tool(MC_TOOL_NAMES.restoreFile, ts).call(ctx, { path });
      rmSync(join(wt, "apps"), { recursive: true });
      const before = gitState();
      const restored = await call("apps/a.ts");
      expect(restored.isError, restored.text).toBeUndefined();
      expect(readFileSync(join(wt, "apps/a.ts"))).toEqual(Buffer.from([0, 255, 10, 13]));
      expect(statSync(join(wt, "apps/a.ts")).mode & 0o777).toBe(0o755);
      expect(gitState()).toEqual(before);
      write("apps/experiment.ts", "experiment");
      const removed = await call("apps/experiment.ts");
      expect(removed.isError, removed.text).toBeUndefined();
      expect(existsSync(join(wt, "apps/experiment.ts"))).toBe(false);
      expect(gitState()).toEqual(before);
    },
  );

  it("removes only an untracked regular file absent from the review head", async () => {
    write("apps/new.ts", "experiment");
    const before = gitState();
    expect((await restore("apps/new.ts")).text).toContain("Removed untracked file");
    expect(existsSync(join(wt, "apps/new.ts"))).toBe(false);
    expect(gitState()).toEqual(before);
    write("apps/new.ts", "staged");
    git(wt, "add", "apps/new.ts");
    expect((await restore("apps/new.ts")).isError).toBe(true);
    expect(readFileSync(join(wt, "apps/new.ts"), "utf8")).toBe("staged");
    expect((await restore("missing")).isError).toBe(true);
    expect((await restore("apps")).isError).toBe(true);
  });

  it("refuses traversal, absolute and git paths, symlinks and symlinked parents", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.ts"), "outside");
    symlinkSync(outside, join(wt, "linked"));
    symlinkSync(join(outside, "a.ts"), join(wt, "link.ts"));
    rmSync(join(wt, "apps"), { recursive: true });
    symlinkSync(outside, join(wt, "apps"));
    for (const path of [
      "../x",
      join(outside, "a.ts"),
      ".git/config",
      ".GIT/config",
      "link.ts",
      "linked/a.ts",
      "apps/a.ts",
    ]) {
      expect((await restore(path)).isError, path).toBe(true);
    }
    expect(readFileSync(join(outside, "a.ts"), "utf8")).toBe("outside");
  });

  it("refuses other modes and ended runs", async () => {
    expect(tool(MC_TOOL_NAMES.restoreFile).modes).toEqual(["scratch"]);
    expect((await tool(MC_TOOL_NAMES.restoreFile).call(CTX, { path: "apps/a.ts" })).isError).toBe(
      true,
    );
    const live = store.run(ctx.runId);
    if (live === null) throw new Error("no run");
    expect(
      (await tool(MC_TOOL_NAMES.restoreFile, make()).call(ctx, { path: "apps/a.ts" })).isError,
    ).toBe(true);
    store.upsertRun({ ...live, endedAt: NOW });
    expect((await restore("apps/a.ts")).text).toBe(MC_RUN_ENDED);
  });
});

describe("preview_browser", () => {
  const ctx = { seatId: "retro", runId: "retro:preview" };
  const ORIGIN = "http://127.0.0.1:7431";
  const png = Buffer.from("PNG");
  let reviewId: number;
  let browse: ReturnType<typeof vi.fn>;
  let cfg: CcConfig;
  const call = (args: unknown, origin: string | null = ORIGIN) => {
    const ts = make({
      config: cfg,
      previewBrowser: {
        ready: async () => ({ origin, note: origin === null ? "the preview did not start" : null }),
        browse: browse as never,
        saveShot: () => "a".repeat(32),
      },
    });
    return tool(MC_TOOL_NAMES.previewBrowser, ts).call(ctx, args);
  };
  beforeEach(() => {
    cfg = config();
    const seat = cfg.crew?.sessions[0]?.seats.find((s) => s.id === ctx.seatId);
    if (!seat) throw new Error("no review seat");
    seat.mode = "scratch";
    browse = vi.fn(async () => ({
      url: `${ORIGIN}/needs-you`,
      report: ["step 1: screenshot wide"],
      shots: [{ label: "wide", png }],
    }));
    const id = store.requestReview({
      authorRunId: RUN,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: "f".repeat(40),
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW,
    });
    if (id === null) throw new Error("no review");
    reviewId = id;
    store.setReviewState(id, ["queued"], "running", { at: NOW, runId: ctx.runId });
    store.upsertRun(run({ id: ctx.runId, agentId: ctx.seatId, reviewId: id }));
    const session = store.seatSession("guido-1");
    if (session === null) throw new Error("no seat session");
    store.setSeatSession({ ...session, seatId: ctx.seatId, runId: ctx.runId });
  });

  it("runs the job on the review's preview, keeps the screenshot and returns it", async () => {
    const r = await call({
      path: "/needs-you",
      width: 1280,
      theme: "light",
      steps: [{ screenshot: "wide" }],
    });
    expect(r.isError).toBeUndefined();
    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse.mock.calls[0]?.[1].origin).toBe(ORIGIN);
    expect(r.image?.data).toBe(png.toString("base64"));
    expect(store.reviewShots(reviewId)).toEqual([
      { id: "a".repeat(32), label: "wide", width: 1280, theme: "light", at: NOW },
    ]);
  });

  it("refuses any other host before a browser starts", async () => {
    for (const path of [
      "http://evil.example/",
      "//evil.example/x",
      "https://127.0.0.1:7431/",
      "http://127.0.0.1:7432/",
      "file:///etc/passwd",
      "data:text/html,hi",
      "needs-you",
    ]) {
      const r = await call({ path });
      expect(r.isError, path).toBe(true);
    }
    expect(browse).not.toHaveBeenCalled();
    expect(store.reviewShots(reviewId)).toEqual([]);
  });

  it("says there is no preview for a review without one", async () => {
    const r = await call({ path: "/" }, null);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No preview for this review");
    expect(browse).not.toHaveBeenCalled();
  });

  it("refuses bad widths, themes, unknown steps and too many screenshots", async () => {
    for (const args of [
      { path: "/", width: 100 },
      { path: "/", theme: "blue" },
      { path: "/", steps: [{ eval: "1" }] },
      { path: "/", steps: Array.from({ length: 7 }, () => ({ screenshot: "s" })) },
    ])
      expect((await call(args)).isError).toBe(true);
    expect(browse).not.toHaveBeenCalled();
  });
});
