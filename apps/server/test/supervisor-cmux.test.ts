// Every Claude seat's run is a cmux workspace; a fake cmux (fixtures/fake-cmux.mjs) stands in for it.
// The file's state is cmux's: a test sets a session's lifecycle to play the operator and Claude.
import "./supervisor-harness.ts";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CMUX_NEEDS_INPUT_TEXT, type Run } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { agentViews } from "../src/hud/hud.ts";
import { cmuxSeatWorkspaceKey } from "../src/runtime/cmux-seat-workspaces.ts";
import { cmuxKeeperKey, cmuxSourceKey, cmuxWorkspaceKey } from "../src/runtime/cmux-session.ts";
import { crewKeeperDir } from "../src/store/crew-paths.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import {
  BRANCH,
  clone,
  dbPath,
  dir,
  git,
  HUB_ROLES,
  make,
  recorded,
  reopenStore,
  root,
  seatState,
  store,
  TICKET,
  until,
  userLines,
} from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

interface FakeCmux {
  workspaces: { id: string; name: string; cwd: string; command: string; goneAt?: number }[];
  sessions: { session_id: string; lifecycle: string; pid: number; workspace_id: string }[];
  sent: { ws: string; text: string }[];
  keys: { key: string; force: boolean }[];
  closed: string[];
  closeAttempts?: string[];
  calls: string[][];
  [k: string]: unknown;
}
const stateFile = () => join(dir, "cmux.json");
const fakeCmux = (over: Record<string, unknown> = {}) =>
  writeFileSync(
    stateFile(),
    JSON.stringify({ autoClaude: true, transcriptDir: dir, claudePid: process.pid, ...over }),
  );
const cmuxState = (): FakeCmux => JSON.parse(readFileSync(stateFile(), "utf8"));
const patch = (fn: (s: FakeCmux) => void) => {
  const s = cmuxState();
  fn(s);
  // whole, then renamed: the fake never reads it half written
  writeFileSync(`${stateFile()}.t`, JSON.stringify(s));
  renameSync(`${stateFile()}.t`, stateFile());
};
const lifecycle = (l: string) =>
  patch((s) => {
    for (const r of s.sessions) r.lifecycle = l;
  });
/** The workspace the hub keeps for a seat in the Mission Control group. */
const seatWs = (seatId = "guido-1") => store.getSetting(cmuxSeatWorkspaceKey(seatId)) as string;
/** A run's launcher, sent into its seat's shell: `cd '<worktree>' && '<launcher>'`. */
const isLaunch = (text: string) => /^cd '[^']+' && '/.test(text);
const launches = () => (cmuxState().sent ?? []).filter((m) => isLaunch(m.text));
const briefs = () => (cmuxState().sent ?? []).filter((m) => !isLaunch(m.text));
/** The folder a launch changes to. */
const launchedIn = (text: string) => /^cd '([^']+)' && /.exec(text)?.[1] as string;
/** Every seat, and the group's anchor, has one workspace: the harness has three seats. */
const GROUP_WORKSPACES = 4;
/** Waits longer than `until`: a start first sets up the seats' workspaces in cmux. */
const untilStarted = (fn: () => unknown) => vi.waitFor(fn, { timeout: 15_000, interval: 20 });
/** The path a long message names. */
const messagePath = (text: string) => /Read (\S+) and act on it\.$/.exec(text)?.[1] as string;
const direction = () => {
  mkdirSync(join(clone, "docs"), { recursive: true });
  writeFileSync(join(clone, "docs/direction.md"), "Fixture direction");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "fixture direction");
  git(clone, "push", "-q", "origin", "main");
};
const flight = {
  id: "flight-1",
  role: "FLIGHT",
  accountId: "claude-main",
  model: "opus",
  area: [],
};

async function started() {
  fakeCmux();
  const made = make({ cmuxState: stateFile() });
  made.sup.start();
  const { runId } = await made.sup.startRun("guido-1", 42);
  await untilStarted(() => expect(briefs()).toHaveLength(1));
  return { ...made, runId };
}

describe("a Claude run in cmux", () => {
  it("starts a Claude run in its seat's workspace", async () => {
    const { runId } = await started();
    const state = cmuxState();
    expect(state.workspaces).toHaveLength(GROUP_WORKSPACES);
    const own = state.workspaces.find((w) => w.id === seatWs());
    expect(own?.name).toBe("guido-1 · o/mc");
    // the launcher goes into the seat's shell, in the run's worktree
    expect(launches()).toHaveLength(1);
    expect(launches()[0]?.ws).toBe(seatWs());
    const worktree = store.seatSession("guido-1")?.worktree as string;
    expect(realpathSync(launchedIn(launches()[0]?.text as string))).toBe(realpathSync(worktree));
    // the hub's own settings and MCP config, interactive, claude's own session id
    const launcher = readFileSync(join(crewKeeperDir(dbPath, runId), "launch.zsh"), "utf8");
    for (const flag of [
      "'--settings'",
      "'--mcp-config'",
      "'--strict-mcp-config'",
      "'--session-id'",
    ])
      expect(launcher).toContain(flag);
    for (const gone of ["'-p'", "'--output-format'", "'--max-budget-usd'"])
      expect(launcher).not.toContain(gone);
    // the brief is a message pointing at its file
    const text = briefs()[0]?.text as string;
    expect(text).toMatch(/^Mission Control sent you a message\. Read .+ and act on it\.$/);
    expect(readFileSync(messagePath(text), "utf8")).toContain("Fix the stop race");
    expect(JSON.parse(store.getSetting(cmuxWorkspaceKey(runId)) as string)).toMatchObject({
      workspace: seatWs(),
      pid: process.pid,
    });
    // the turn: running, then idle with the run still open
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.run(runId)?.endedAt).toBeNull();
  });

  it("seat state follows cmux", async () => {
    const { cfg } = await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    lifecycle("needsInput");
    await until(() => expect(seatState("guido-1")).toBe("needs-input"));
    expect(store.seatSession("guido-1")?.reason).toBe(CMUX_NEEDS_INPUT_TEXT);
    const seat = agentViews(cfg, store).find((a) => a.id === "guido-1");
    expect(seat?.state).toBe("waiting-you");
    expect(seat?.note).toBe(CMUX_NEEDS_INPUT_TEXT);
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.seatSession("guido-1")?.reason).toBeNull();
  });

  it("an operator's /clear keeps the run", async () => {
    const { runId } = await started();
    const fresh = "33333333-3333-4333-8333-333333333333";
    patch((s) => {
      for (const r of s.sessions) r.session_id = fresh;
    });
    await until(() => expect(store.run(runId)?.sessionId).toBe(fresh));
    expect(store.seatSession("guido-1")?.cliSessionId).toBe(fresh);
    expect(store.run(runId)?.endedAt).toBeNull();
    expect(cmuxState().closed ?? []).toEqual([]);
  });

  it("an operator's own prompt is a turn", async () => {
    const { runId } = await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    lifecycle("running"); // typed into the workspace, not sent by the hub
    await until(() => expect(seatState("guido-1")).toBe("running"));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.run(runId)?.endedAt).toBeNull();
  });

  /** The `t` of each line of Claude's own that the run transcript holds. */
  const copiedTs = (runId: string) =>
    readFileSync(store.run(runId)?.transcriptPath as string, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l).t)
      .filter((t) => t !== undefined);
  const claudeFile = () => {
    const rec = cmuxState().sessions[0];
    return join(dir, `${rec?.session_id}.jsonl`);
  };
  const claudeLines = (...ts: string[]) =>
    appendFileSync(
      claudeFile(),
      `${ts.map((t) => JSON.stringify({ type: "assistant", t })).join("\n")}\n`,
    );

  it("a restart attaches from the durable source cursor when the workspace setting has none", async () => {
    const first = await started();
    claudeLines("1", "2");
    await until(() => expect(copiedTs(first.runId)).toEqual(["1", "2"]));
    expect(store.getSetting(cmuxSourceKey(first.runId))).not.toBeNull();
    await first.sup.stopAll();
    reopenStore();
    // a resume that saved only {workspace, pid} before the hub went down
    const saved = JSON.parse(store.getSetting(cmuxWorkspaceKey(first.runId)) as string);
    store.setSetting(
      cmuxWorkspaceKey(first.runId),
      JSON.stringify({ workspace: saved.workspace, pid: saved.pid }),
    );
    const second = make({ cmuxState: stateFile() });
    second.sup.start();
    await until(() => expect(second.sup.sessionAlive?.("guido-1")).toBe(true));
    claudeLines("3");
    await until(() => expect(copiedTs(first.runId)).toEqual(["1", "2", "3"]));
    await new Promise((r) => setTimeout(r, 200));
    expect(copiedTs(first.runId)).toEqual(["1", "2", "3"]);
  });

  it("a hub restart with the saved pid dead resumes in the seat's workspace without copying Claude's transcript again", async () => {
    const first = await started();
    claudeLines("1", "2");
    await until(() => expect(copiedTs(first.runId)).toEqual(["1", "2"]));
    await first.sup.stopAll();
    reopenStore();
    // the process the hub saved is gone
    store.setSetting(
      cmuxWorkspaceKey(first.runId),
      JSON.stringify({
        ...JSON.parse(store.getSetting(cmuxWorkspaceKey(first.runId)) as string),
        pid: 2 ** 22 + 99,
      }),
    );
    const second = make({ cmuxState: stateFile() });
    second.sup.start();
    await until(() => expect(second.sup.sessionAlive?.("guido-1")).toBe(true));
    await until(() =>
      expect(
        readFileSync(join(crewKeeperDir(dbPath, first.runId), "launch.zsh"), "utf8"),
      ).toContain("'--resume'"),
    );
    // the seat's workspace stays: the resume is launched into it again
    await until(() => expect(launches()).toHaveLength(2));
    expect(launches().map((m) => m.ws)).toEqual([seatWs(), seatWs()]);
    expect(cmuxState().closed ?? []).toEqual([]);
    await until(() => expect(cmuxState().sessions).toHaveLength(1));
    claudeLines("3");
    await until(() => expect(copiedTs(first.runId)).toEqual(["1", "2", "3"]));
  });

  it("a hub restart with cmux down and the saved pid dead resumes the run on the keeper", async () => {
    const first = await started();
    await first.sup.stopAll();
    reopenStore();
    store.setSetting(
      cmuxWorkspaceKey(first.runId),
      JSON.stringify({
        ...JSON.parse(store.getSetting(cmuxWorkspaceKey(first.runId)) as string),
        pid: 2 ** 22 + 99,
      }),
    );
    // cmux is not running after a reboot, and will not start
    patch((s) => {
      s.down = true;
    });
    const second = make({ cmuxState: stateFile() });
    second.sup.start();
    await until(() => expect(recorded().length).toBeGreaterThan(0));
    expect(recorded()[0].argv as string[]).toContain("-p");
    expect(existsSync(join(crewKeeperDir(dbPath, first.runId), "keeper.pid"))).toBe(true);
    expect(store.run(first.runId)?.endedAt).toBeNull();
    expect(store.getSetting(cmuxWorkspaceKey(first.runId))).toBeNull();
  });

  it("a cmux start that shows no Claude goes on under a keeper, which gets the brief", async () => {
    // cmux opens the workspace but never shows a Claude: no record, no prompt, no transcript
    fakeCmux({ autoClaude: false });
    const made = make({ cmuxState: stateFile(), cmuxStartWaitMs: 300 });
    made.sup.start();
    const { runId } = await made.sup.startRun("guido-1", 42);
    await untilStarted(() => expect(userLines().join("\n")).toContain("Fix the stop race"));
    // the seat's workspace stays for its next run
    expect(cmuxState().closed ?? []).not.toContain(seatWs());
    const argv = recorded()[0].argv as string[];
    expect(argv).toContain("-p");
    expect(argv).toContain("--settings");
    expect(existsSync(join(crewKeeperDir(dbPath, runId), "keeper.pid"))).toBe(true);
    expect(store.getSetting(cmuxKeeperKey(runId))).toBe("1");
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
    // the run carries on: its turn ends idle, not in error
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.run(runId)?.endedAt).toBeNull();
    expect(briefs()).toEqual([]);
  });

  it("a seat workspace cmux cannot find goes on under a keeper", async () => {
    // cmux answers its ping, but the workspaces it is asked for never show in its list
    fakeCmux({ autoClaude: false, hideWorkspaces: true });
    const made = make({ cmuxState: stateFile() });
    made.sup.start();
    const { runId } = await made.sup.startRun("guido-1", 42);
    await vi.waitFor(() => expect(userLines().join("\n")).toContain("Fix the stop race"), {
      timeout: 12_000,
      interval: 20,
    });
    expect(store.getSetting(cmuxKeeperKey(runId))).toBe("1");
    expect(store.run(runId)?.endedAt).toBeNull();
  });

  it("a restored agent with a new pid is closed and resumed with the hub's command", async () => {
    const { runId } = await started();
    claudeLines("1", "2");
    await until(() => expect(copiedTs(runId)).toEqual(["1", "2"]));
    // a Claude the hub did not start runs in the seat's workspace: it goes, and the seat gets a new one
    const first = seatWs();
    patch((s) => {
      for (const r of s.sessions) r.pid = process.pid + 1;
    });
    await until(() => expect(cmuxState().closed).toEqual([first]));
    await untilStarted(() => expect(seatWs()).not.toBe(first));
    await untilStarted(() => expect(launches().at(-1)?.ws).toBe(seatWs()));
    expect(cmuxState().workspaces.map((w) => w.id)).not.toContain(first);
    expect(cmuxState().workspaces).toHaveLength(GROUP_WORKSPACES);
    const launcher = readFileSync(join(crewKeeperDir(dbPath, runId), "launch.zsh"), "utf8");
    expect(launcher).toContain("'--resume'");
    expect(launcher).toContain("'--settings'");
    expect(store.run(runId)?.endedAt).toBeNull();
    // Claude keeps writing the same transcript: its earlier lines are not copied again
    await until(() => expect(store.getSetting(cmuxWorkspaceKey(runId))).not.toBeNull());
    claudeLines("3");
    await until(() => expect(copiedTs(runId)).toEqual(["1", "2", "3"]));
  });

  it("a restart starts its new workspace only once cmux stops listing the closed one", async () => {
    const { runId } = await started();
    const first = seatWs();
    // cmux answers the close at once but lists the workspace a second longer
    patch((s) => {
      s.linger = 1000;
      for (const r of s.sessions) r.pid = process.pid + 1;
    });
    await until(() => expect(cmuxState().closed).toEqual([first]));
    await untilStarted(() => expect(seatWs()).not.toBe(first));
    await untilStarted(() => expect(launches().at(-1)?.ws).toBe(seatWs()));
    // no new workspace was made while the old one of its name was still listed
    expect(cmuxState().sameName ?? []).toEqual([]);
    expect(store.run(runId)?.endedAt).toBeNull();
  }, 20_000);

  it("keeps the seat's workspace when the run ends, idle with its last ticket", async () => {
    const { sup, runId } = await started();
    const ws = seatWs();
    await sup.endRun("guido-1");
    expect(cmuxState().closed ?? []).not.toContain(ws);
    expect(cmuxState().workspaces.map((w) => w.id)).toContain(ws);
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
    expect(store.run(runId)?.endedAt).not.toBeNull();
    await until(() =>
      expect((cmuxState().statuses as Record<string, Record<string, string>>)[ws]).toMatchObject({
        "mc-seat": "Idle · mc#42",
      }),
    );
  });

  it("ends a run when cmux cannot list its workspaces, and keeps the seat's workspace", async () => {
    const { sup, runId } = await started();
    const ws = seatWs();
    patch((s) => {
      s.listWorkspacesFails = true;
    });

    await sup.endRun("guido-1");

    expect(store.run(runId)?.endedAt).not.toBeNull();
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
    expect(cmuxState().closeAttempts ?? []).not.toContain(ws);
  });

  it("a Claude exit leaves the seat's workspace open for its next run", async () => {
    const claude = spawn("sleep", ["60"], { stdio: "ignore" });
    fakeCmux({ claudePid: claude.pid });
    const { sup } = make({ cmuxState: stateFile() });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await untilStarted(() => expect(briefs()).toHaveLength(1));
    const ws = seatWs();

    claude.kill("SIGKILL");

    await until(() => expect(store.run(runId)?.endedAt).not.toBeNull());
    expect(cmuxState().closeAttempts ?? []).not.toContain(ws);
    expect(cmuxState().workspaces.map((w) => w.id)).toContain(ws);
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
    patch((s) => {
      s.claudePid = process.pid;
    });
    await sup.startRun("guido-1", 42);
    await untilStarted(() => expect(launches()).toHaveLength(2));
    expect(launches().map((m) => m.ws)).toEqual([ws, ws]);
  });

  it("five runs in a row on one seat start in its one workspace", async () => {
    fakeCmux();
    const { sup } = make({ cmuxState: stateFile() });
    sup.start();
    for (let n = 1; n <= 5; n++) {
      await sup.startRun("guido-1", 42);
      await untilStarted(() => expect(briefs()).toHaveLength(n));
      await sup.endRun("guido-1");
    }
    const ws = seatWs();
    expect(launches().map((m) => m.ws)).toEqual([ws, ws, ws, ws, ws]);
    expect(cmuxState().workspaces).toHaveLength(GROUP_WORKSPACES);
    expect(cmuxState().workspaces.filter((w) => w.name === "guido-1 · o/mc")).toHaveLength(1);
    expect(cmuxState().closed ?? []).toEqual([]);
    expect(cmuxState().sameName ?? []).toEqual([]);
  }, 60_000);

  it("keeper runs while cmux is down leave the seat's workspace for its next cmux start", async () => {
    const { sup } = await started();
    const ws = seatWs();
    await sup.endRun("guido-1");
    patch((s) => {
      s.down = true;
    });
    for (let n = 0; n < 3; n++) {
      await sup.startRun("guido-1", 42);
      await sup.endRun("guido-1");
    }
    patch((s) => {
      s.down = false;
    });

    await sup.startRun("guido-1", 42);
    await untilStarted(() => expect(launches()).toHaveLength(2));
    expect(launches().map((m) => m.ws)).toEqual([ws, ws]);
    expect(seatWs()).toBe(ws);
    expect(cmuxState().workspaces).toHaveLength(GROUP_WORKSPACES);
    expect(cmuxState().sameName ?? []).toEqual([]);
  }, 30_000);

  it.each([
    ["refuses the hub", { denied: true }],
    ["is down", { down: true }],
  ])("starts FLIGHT on the keeper when cmux %s", async (_what, over) => {
    direction();
    fakeCmux(over);
    const { sup, log } = make({ cmuxState: stateFile(), extraSeat: flight });
    sup.start();
    const { runId } = await sup.startWatch(flight.id);
    await until(() => expect(recorded().length).toBeGreaterThan(0));
    const argv = recorded()[0].argv as string[];
    expect(argv).toContain("-p");
    expect(argv).toContain("--settings");
    expect(existsSync(join(crewKeeperDir(dbPath, runId), "keeper.pid"))).toBe(true);
    expect(cmuxState().workspaces ?? []).toEqual([]);
    expect(store.getSetting(cmuxKeeperKey(runId))).toBe("1");
    expect(log.mock.calls.some(([m]) => String(m).includes("starting on the keeper instead"))).toBe(
      true,
    );
  });

  it("reads the seat's context use from Claude's transcript", async () => {
    const { sup, runId } = await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    appendFileSync(
      claudeFile(),
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_input_tokens: 140_000,
            cache_creation_input_tokens: 12_000,
          },
        },
      })}\n`,
    );
    await until(() => expect(store.digest(runId)?.contextTokens).toBe(153_000));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect((await sup.contextUsage("guido-1"))?.total).toBe(153_000);
  });

  it("takes a run back after a hub restart by attaching to its workspace", async () => {
    const first = await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    const before = cmuxState().workspaces.length;
    await first.sup.stopAll();
    reopenStore();
    const second = make({ cmuxState: stateFile() });
    second.sup.start();
    await until(() => expect(second.sup.sessionAlive?.("guido-1")).toBe(true));
    lifecycle("idle");
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(cmuxState().workspaces).toHaveLength(before);
    expect(store.run(first.runId)?.endedAt).toBeNull();
  });
});

/** An author run with a pushed PR head, and a review of it in `starting` (as supervisor-review's). */
function reviewOfPush() {
  const seed = join(dir, "seed");
  git(seed, "checkout", "-q", "-b", "pr");
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "pr change");
  git(seed, "push", "-q", "origin", "pr");
  const sha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-q", "main");
  const author: Run = {
    id: "guido-1:20261020T000000Z",
    agentId: "guido-1",
    repoId: "mc",
    seq: 1,
    startedAt: 1,
    endedAt: null,
    status: "running",
    sessionId: "s",
    model: "haiku",
    branch: BRANCH,
    ticket: "mc#42",
    ticketTitle: TICKET.title,
    costUsd: null,
    tokens: null,
    transcriptPath: join(dir, "author.jsonl"),
    prs: [],
    summary: null,
  };
  store.upsertRun(author);
  store.setRunPush({ runId: author.id, sha, at: 1 });
  store.setSeatSession({
    seatId: "guido-1",
    runId: author.id,
    cliSessionId: "c",
    state: "running",
    reason: null,
    worktree: join(root, "mc-crew", "guido-1-42"),
    updatedAt: 1,
  });
  const reviewId = store.requestReview({
    authorRunId: author.id,
    repoId: "mc",
    seatId: "guido-1",
    prNumber: 9,
    sha,
    epoch: 0,
    attempt: 1,
    round: 1,
    at: 1,
  }) as number;
  store.setReviewState(reviewId, ["queued"], "starting", { at: 2 });
  return reviewId;
}

describe("a review seat in cmux", () => {
  it("starts in the seat's workspace on its review worktree and makes no keeper", async () => {
    const reviewId = reviewOfPush();
    fakeCmux();
    const { sup } = make({ cmuxState: stateFile(), scratchRetro: true });
    sup.start();
    const { runId } = await sup.startReview("retro", reviewId);
    await untilStarted(() => expect(launches()).toHaveLength(1));
    expect(launches()[0]?.ws).toBe(seatWs("retro"));
    expect(cmuxState().workspaces.find((w) => w.id === seatWs("retro"))?.name).toBe("retro · o/mc");
    expect(realpathSync(launchedIn(launches()[0]?.text as string))).toBe(
      realpathSync(store.seatSession("retro")?.worktree as string),
    );
    const folder = crewKeeperDir(dbPath, runId);
    for (const name of ["keeper.pid", "spec.json", "s"])
      expect(existsSync(join(folder, name)), name).toBe(false);
    expect(existsSync(join(folder, "launch.zsh"))).toBe(true);
  });
});

describe("no keeper for any Claude seat", () => {
  const noKeeper = (runId: string) => {
    const folder = crewKeeperDir(dbPath, runId);
    for (const name of ["keeper.pid", "spec.json", "s"])
      expect(existsSync(join(folder, name)), name).toBe(false);
    expect(existsSync(join(folder, "launch.zsh"))).toBe(true);
  };

  it("a writer, a planner and the watch seat each get a workspace", async () => {
    direction();
    fakeCmux();
    const rolesDir = join(dir, "roles");
    mkdirSync(rolesDir);
    writeFileSync(join(rolesDir, "FAO.md"), "# FAO: planner\n");
    for (const role of ["GUIDO", "FLIGHT"])
      copyFileSync(join(HUB_ROLES, `${role}.md`), join(rolesDir, `${role}.md`));
    const { sup } = make({ cmuxState: stateFile(), rolesDir, extraSeat: flight });
    sup.start();
    const writer = await sup.startRun("guido-1", 42);
    const planner = await sup.startRun("fao-1", 43);
    const watch = await sup.startWatch(flight.id);
    await untilStarted(() => expect(launches()).toHaveLength(3));
    expect(launches().map((m) => m.ws)).toEqual([
      seatWs("guido-1"),
      seatWs("fao-1"),
      seatWs(flight.id),
    ]);
    // the group's anchor and one workspace for each of the four seats
    expect(cmuxState().workspaces).toHaveLength(GROUP_WORKSPACES + 1);
    for (const { runId } of [writer, planner, watch]) noKeeper(runId);
    expect(recorded()).toEqual([]);
  });
});
