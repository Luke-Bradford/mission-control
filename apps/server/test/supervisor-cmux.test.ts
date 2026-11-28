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
import { CMUX_NEEDS_INPUT_TEXT, FLIGHT_SIGNALS_SETTING, type Run } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { agentViews } from "../src/hud/hud.ts";
import {
  CMUX_WORKSPACE_PREFIX,
  cmuxKeeperKey,
  cmuxSourceKey,
  cmuxWorkspaceKey,
} from "../src/runtime/cmux-session.ts";
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
  sent: { text: string }[];
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
  await until(() => expect(cmuxState().sent).toHaveLength(1));
  return { ...made, runId };
}

describe("a Claude run in cmux", () => {
  it("starts a Claude run in a cmux workspace", async () => {
    const { runId } = await started();
    const state = cmuxState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.name).toBe("guido-1 · mc#42");
    const worktree = store.seatSession("guido-1")?.worktree as string;
    expect(realpathSync(state.workspaces[0]?.cwd as string)).toBe(realpathSync(worktree));
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
    const text = cmuxState().sent[0]?.text as string;
    expect(text).toMatch(/^Mission Control sent you a message\. Read .+ and act on it\.$/);
    expect(readFileSync(messagePath(text), "utf8")).toContain("Fix the stop race");
    expect(JSON.parse(store.getSetting(cmuxWorkspaceKey(runId)) as string)).toMatchObject({
      workspace: state.workspaces[0]?.id,
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

  // #2304: a dialog nobody answered left the run "working" and FLIGHT idle
  it("a dialog left open is waiting, and FLIGHT is called with its question and options, once", async () => {
    await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    patch((s) => {
      s.screen = [
        "────────────────────────────────────────────────────────────",
        " Which database should I use?",
        " ❯ 1. Postgres",
        "   2. SQLite",
        " Enter to select · Esc to cancel",
      ].join("\n");
    });
    // cmux's record still says running: the screen decides
    await until(() => expect(seatState("guido-1")).toBe("needs-input"));
    const calls = () =>
      Object.values(
        JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}").signals ?? {},
      ) as { kind: string; evidence: string }[];
    await until(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]).toMatchObject({ kind: "seat_call" });
    expect(calls()[0]?.evidence).toContain("Which database should I use?");
    expect(calls()[0]?.evidence).toContain("1. Postgres");
    expect(calls()[0]?.evidence).toContain("2. SQLite");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls()).toHaveLength(1);
  });

  it("does not call FLIGHT when a stale cmux needs-input record outlives its dialog", async () => {
    await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    patch((s) => {
      s.screen = [
        "────────────────────────────────────────────────────────────",
        " Which database should I use?",
        " ❯ 1. Postgres",
        "   2. SQLite",
        " Enter to select · Esc to cancel",
      ].join("\n");
    });
    await until(() => expect(seatState("guido-1")).toBe("needs-input"));
    lifecycle("needsInput");
    patch((s) => {
      s.screen = "Claude is thinking";
    });
    await new Promise((r) => setTimeout(r, 150));
    const calls = Object.values(
      JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}").signals ?? {},
    );
    expect(calls).toHaveLength(0);
  });

  it("restarts the dialog deadline when cmux changes dialogs without changing lifecycle", async () => {
    await started();
    lifecycle("running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    patch((s) => {
      s.screen = [
        "────────────────────────────────────────────────────────────",
        " Which database should I use?",
        " ❯ 1. Postgres",
        "   2. SQLite",
        " Enter to select · Esc to cancel",
      ].join("\n");
    });
    await until(() => expect(seatState("guido-1")).toBe("needs-input"));
    lifecycle("needsInput");
    patch((s) => {
      s.screen = [
        "────────────────────────────────────────────────────────────",
        " Which cache should I use?",
        " ❯ 1. Redis",
        "   2. Memcached",
        " Enter to select · Esc to cancel",
      ].join("\n");
    });
    const calls = () =>
      Object.values(
        JSON.parse(store.getSetting(`${FLIGHT_SIGNALS_SETTING}:mc`) ?? "{}").signals ?? {},
      ) as { evidence: string }[];
    await until(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]?.evidence).toContain("Which cache should I use?");
    expect(calls()[0]?.evidence).toContain("1. Redis");
    expect(calls()[0]?.evidence).not.toContain("Which database should I use?");
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

  it("a hub restart with the saved pid dead resumes in a new workspace without copying Claude's transcript again", async () => {
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
    await until(() => expect(cmuxState().closed).toHaveLength(1));
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
    await until(() => expect(cmuxState().closed).toHaveLength(1));
    await until(() => expect(userLines().join("\n")).toContain("Fix the stop race"));
    const argv = recorded()[0].argv as string[];
    expect(argv).toContain("-p");
    expect(argv).toContain("--settings");
    expect(existsSync(join(crewKeeperDir(dbPath, runId), "keeper.pid"))).toBe(true);
    expect(store.getSetting(cmuxKeeperKey(runId))).toBe("1");
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
    // the run carries on: its turn ends idle, not in error
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(store.run(runId)?.endedAt).toBeNull();
    expect(cmuxState().sent ?? []).toEqual([]);
  });

  it("a workspace cmux cannot find goes on under a keeper", async () => {
    // cmux answers its ping, but the workspace it is asked for never shows in its list
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
    const first = cmuxState().workspaces[0]?.id;
    patch((s) => {
      for (const r of s.sessions) r.pid = process.pid + 1;
    });
    await until(() => expect(cmuxState().closed).toEqual([first]));
    await until(() => expect(cmuxState().workspaces.map((w) => w.id)).not.toContain(first));
    await until(() => expect(cmuxState().workspaces).toHaveLength(1));
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
    const first = cmuxState().workspaces[0]?.id;
    // cmux answers the close at once but lists the workspace a second longer
    patch((s) => {
      s.linger = 1000;
      for (const r of s.sessions) r.pid = process.pid + 1;
    });
    await until(() => expect(cmuxState().closed).toEqual([first]));
    await until(() =>
      expect(cmuxState().workspaces.some((w) => w.id !== first && w.goneAt === undefined)).toBe(
        true,
      ),
    );
    // no new workspace was made while the old one of its name was still listed
    expect(cmuxState().sameName ?? []).toEqual([]);
    expect(store.run(runId)?.endedAt).toBeNull();
  }, 10_000);

  it("closes the workspace when the run ends", async () => {
    const { sup, runId } = await started();
    const ws = cmuxState().workspaces[0]?.id;
    await sup.endRun("guido-1");
    expect(cmuxState().closed).toContain(ws);
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
    expect(store.run(runId)?.endedAt).not.toBeNull();
  });

  it("keeps a closed workspace when cmux cannot verify that it disappeared", async () => {
    fakeCmux({ claudePid: 999_999 });
    const { sup } = make({ cmuxState: stateFile() });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(cmuxState().sent).toHaveLength(1));
    patch((s) => {
      s.listWorkspacesFails = true;
    });

    await sup.endRun("guido-1");

    expect(store.getSetting(cmuxWorkspaceKey(runId))).not.toBeNull();
  });

  it("retries closing a workspace when Claude exits", async () => {
    const claude = spawn("sleep", ["60"], { stdio: "ignore" });
    fakeCmux({ claudePid: claude.pid, noClose: true });
    const { sup } = make({ cmuxState: stateFile() });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(cmuxState().sent).toHaveLength(1));
    const workspace = cmuxState().workspaces[0]?.id;

    claude.kill("SIGKILL");

    await until(() => expect(store.run(runId)?.endedAt).not.toBeNull());
    await until(() =>
      expect(cmuxState().closeAttempts?.filter((id) => id === workspace)).toHaveLength(2),
    );
    expect(store.getSetting(cmuxWorkspaceKey(runId))).not.toBeNull();
  });

  it("a workspace cmux will not close after Claude exits keeps the seat's next start until it closes", async () => {
    const claude = spawn("sleep", ["60"], { stdio: "ignore" });
    fakeCmux({ claudePid: claude.pid });
    const { sup } = make({ cmuxState: stateFile() });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(cmuxState().sent).toHaveLength(1));
    const name = cmuxState().workspaces[0]?.name;
    const named = () => cmuxState().workspaces.filter((w) => w.name === name);
    patch((s) => {
      s.noClose = true;
      s.claudePid = process.pid;
    });
    claude.kill("SIGKILL");
    await until(() => expect(store.run(runId)?.endedAt).not.toBeNull());
    // Claude is dead, but cmux still lists its workspace: the hub keeps it to close
    expect(store.getSetting(cmuxWorkspaceKey(runId))).not.toBeNull();
    await expect(sup.startRun("guido-1", 42)).rejects.toThrow(/earlier cmux workspace/);
    expect(named()).toHaveLength(1);
    patch((s) => {
      s.noClose = false;
    });
    const next = await sup.startRun("guido-1", 42);
    await until(() => expect(cmuxState().sent).toHaveLength(2));
    expect(named()).toHaveLength(1);
    expect(named()[0]?.id).toBe(
      JSON.parse(store.getSetting(cmuxWorkspaceKey(next.runId)) as string).workspace,
    );
    expect(store.getSetting(cmuxWorkspaceKey(runId))).toBeNull();
  });

  it("keeps an older saved workspace before opening another one", async () => {
    const claude = spawn("sleep", ["60"], { stdio: "ignore" });
    fakeCmux({ claudePid: claude.pid });
    const { sup } = make({ cmuxState: stateFile() });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(cmuxState().sent).toHaveLength(1));
    patch((s) => {
      s.noClose = true;
      s.claudePid = process.pid;
    });
    claude.kill("SIGKILL");
    await until(() => expect(store.run(runId)?.endedAt).not.toBeNull());
    expect(store.getSetting(cmuxWorkspaceKey(runId))).not.toBeNull();

    // Ten newer keeper runs must not hide the old workspace from a later cmux start.
    patch((s) => {
      s.down = true;
    });
    for (let n = 0; n < 10; n++) {
      await sup.startRun("guido-1", 42);
      await sup.endRun("guido-1");
    }
    patch((s) => {
      s.down = false;
    });

    expect(
      store.runsWithSettingPrefix("guido-1", CMUX_WORKSPACE_PREFIX).map((run) => run.id),
    ).toContain(runId);
    await expect(sup.startRun("guido-1", 42)).rejects.toThrow(/earlier cmux workspace/);
    expect(cmuxState().workspaces).toHaveLength(1);
    expect(cmuxState().sameName ?? []).toEqual([]);
  }, 20_000);

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
  it("opens one PR workspace on its review worktree and makes no keeper", async () => {
    const reviewId = reviewOfPush();
    fakeCmux();
    const { sup } = make({ cmuxState: stateFile(), scratchRetro: true });
    sup.start();
    const { runId } = await sup.startReview("retro", reviewId);
    await until(() => expect(cmuxState().workspaces).toHaveLength(1));
    const ws = cmuxState().workspaces[0];
    expect(ws?.name).toBe("retro · PR 9");
    expect(realpathSync(ws?.cwd as string)).toBe(
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
    await until(() => expect(cmuxState().workspaces).toHaveLength(3));
    expect(cmuxState().workspaces.map((w) => w.name)).toEqual([
      "guido-1 · mc#42",
      "fao-1 · mc#43",
      "flight-1 · FLIGHT",
    ]);
    for (const { runId } of [writer, planner, watch]) noKeeper(runId);
    expect(recorded()).toEqual([]);
  });
});
