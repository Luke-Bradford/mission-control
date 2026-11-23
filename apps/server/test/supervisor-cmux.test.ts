import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CMUX_DOWN_TEXT, CMUX_REFUSED_TEXT } from "../src/runtime/cmux.ts";
import { crewKeeperDir } from "../src/store/crew-paths.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import { dbPath, dir, make, seatState, store, until } from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

const fake = fileURLToPath(new URL("./fixtures/fake-cmux.mjs", import.meta.url));
const files: string[] = [];
afterEach(() => files.splice(0));
beforeEach(() => vi.stubEnv("TMPDIR", dir));
afterEach(() => vi.unstubAllEnvs());

const edit = (state: string, f: (session: Record<string, unknown>) => void) => {
  const value = JSON.parse(readFileSync(state, "utf8")) as { sessions: Record<string, unknown>[] };
  f(value.sessions[0] ?? {});
  writeFileSync(state, JSON.stringify(value));
};

// The launcher is a zsh script for the Mac: the bridged fake runs it for real where zsh exists.
it.skipIf(!existsSync("/bin/zsh"))("starts a Claude run in a cmux workspace", async () => {
  const state = join(dir, "fake-cmux.json");
  files.push(state);
  // the bridged fake runs launch.zsh, which execs the fake Claude; the brief reaches that process
  // through cmux and its stdout is the transcript, so a launcher that cannot run Claude fails here
  writeFileSync(state, JSON.stringify({ sessions: [], calls: [], bridge: true }));
  const { sup } = make({ cmuxCommand: [process.execPath, fake, state] });
  sup.start();
  const run = await sup.startRun("guido-1", 42);
  const created = () => JSON.parse(readFileSync(state, "utf8")).sessions[0];
  await until(() => expect(created()).toBeDefined());
  expect(created().cwd).toContain("worktrees");
  const launcher = readFileSync(created().command, "utf8");
  expect(launcher).toContain("--settings");
  expect(launcher).not.toContain("--setting-sources");
  expect(launcher).toContain("--mcp-config");
  expect(launcher).toContain("--strict-mcp-config");
  expect(launcher).toContain("--session-id");
  expect(launcher).not.toContain(" -p ");
  const sent = () =>
    JSON.parse(readFileSync(state, "utf8")).calls.find((call: string[]) => call[0] === "send");
  await until(() => expect(sent()).toBeDefined());
  expect(sent().at(-1)).toMatch(/^Mission Control sent you a message\. Read .+ and act on it\.$/);
  // the brief reached Claude's transcript, the turn ran, and the seat is idle after the result
  const copied = () => readFileSync(store.run(run.runId)?.transcriptPath ?? "", "utf8");
  await until(() => expect(copied()).toContain('"text":"echo: '));
  await until(() => expect(copied()).toContain('"mc_cmux":true'));
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  expect(copied()).toContain(`"session_id":"${launcher.match(/--session-id' '([^']+)'/)?.[1]}"`);
  for (const session of JSON.parse(readFileSync(state, "utf8")).sessions)
    try {
      process.kill(-session.pgid, "SIGTERM");
    } catch {}
});

it("seat state follows cmux and /clear keeps the run", async () => {
  const state = join(dir, "fake-cmux.json");
  const { sup } = make({ cmuxCommand: [process.execPath, fake, state] });
  sup.start();
  const run = await sup.startRun("guido-1", 42);
  await until(() => expect(readFileSync(state, "utf8")).toContain("workspace_id"));
  edit(state, (session) => {
    session.agent_lifecycle = "running";
  });
  await until(() => expect(seatState("guido-1")).toBe("running"));
  edit(state, (session) => {
    session.agent_lifecycle = "idle";
  });
  await until(() => expect(seatState("guido-1")).toBe("idle"));

  edit(state, (session) => {
    session.agent_lifecycle = "running";
  });
  await until(() => expect(seatState("guido-1")).toBe("running"));
  edit(state, (session) => {
    session.agent_lifecycle = "needsInput";
  });
  await until(() =>
    expect(store.seatSession("guido-1")).toMatchObject({
      state: "needs-input",
      reason: "Needs your input in cmux",
    }),
  );
  const cleared = "11111111-2222-3333-4444-555555555555";
  edit(state, (session) => {
    session.session_id = cleared;
    session.agent_lifecycle = "idle";
  });
  await until(() => expect(store.seatSession("guido-1")?.cliSessionId).toBe(cleared));
  expect(store.run(run.runId)?.sessionId).toBe(cleared);
  expect(store.run(run.runId)?.endedAt).toBeNull();
});

const calls = (state: string): string[][] => JSON.parse(readFileSync(state, "utf8")).calls;
const sessions = (state: string): Record<string, string>[] =>
  JSON.parse(readFileSync(state, "utf8")).sessions;
const setLifecycle = (state: string, lifecycle: string) =>
  edit(state, (session) => {
    session.agent_lifecycle = lifecycle;
  });

/** A run with its cmux agent registered and a first turn driven through, so the row is idle. */
async function idleRun() {
  const state = join(dir, "fake-cmux.json");
  const first = make({ cmuxCommand: [process.execPath, fake, state] });
  first.sup.start();
  const run = await first.sup.startRun("guido-1", 42);
  await until(() => expect(readFileSync(state, "utf8")).toContain("workspace_id"));
  setLifecycle(state, "running");
  await until(() => expect(seatState("guido-1")).toBe("running"));
  setLifecycle(state, "idle");
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  return { state, first, run };
}

const restart = async (state: string, first: { sup: { stopAll(): Promise<void> } }) => {
  await first.sup.stopAll();
  const next = make({ cmuxCommand: [process.execPath, fake, state] });
  next.sup.start();
  return next;
};

it("an operator's own prompt is a turn", async () => {
  const { state, run } = await idleRun();
  const started = store.seatSession("guido-1")?.lastTurnStartedAt ?? 0;
  await new Promise((r) => setTimeout(r, 5));
  setLifecycle(state, "running");
  await until(() => expect(seatState("guido-1")).toBe("running"));
  expect(store.seatSession("guido-1")?.lastTurnStartedAt).toBeGreaterThan(started);
  setLifecycle(state, "idle");
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  expect(store.run(run.runId)?.endedAt).toBeNull();
});

it("a restored agent with a new pid is closed and resumed with the hub's command", async () => {
  const { state, run } = await idleRun();
  const launcher = sessions(state)[0]?.command as string;
  edit(state, (session) => {
    session.pid = 2;
  });
  await until(() =>
    expect(calls(state).some((c) => c[0] === "close-workspace" && c.includes("--force"))).toBe(
      true,
    ),
  );
  await until(() => expect(calls(state).filter((c) => c[0] === "new-workspace")).toHaveLength(2));
  const text = readFileSync(launcher, "utf8");
  expect(text).toContain("'--resume'");
  expect(text).toContain("'--settings'");
  expect(store.run(run.runId)?.endedAt).toBeNull();
});

it("no keeper for any Claude seat", async () => {
  const state = join(dir, "fake-cmux.json");
  const rolesDir = join(dir, "roles");
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, "FLIGHT.md"), "# FLIGHT: head agent\n");
  writeFileSync(join(rolesDir, "FAO.md"), "# FAO: planner\n");
  writeFileSync(join(rolesDir, "GUIDO.md"), "# GUIDO: developer\n");
  const { sup } = make({
    cmuxCommand: [process.execPath, fake, state],
    rolesDir,
    extraSeat: {
      id: "flight-1",
      role: "FLIGHT",
      accountId: "claude-main",
      model: "opus",
      area: [],
    },
  });
  sup.start();
  const runs = [
    (await sup.startRun("guido-1", 42)).runId,
    (await sup.startRun("fao-1", 43)).runId,
    (await sup.startWatch("flight-1")).runId,
  ];
  await until(() => expect(calls(state).filter((c) => c[0] === "new-workspace")).toHaveLength(3));
  for (const runId of runs)
    for (const f of ["keeper.pid", "spec.json", "s"])
      expect(existsSync(join(crewKeeperDir(dbPath, runId), f))).toBe(false);
});

it("a Codex seat still has a keeper", async () => {
  const { sup } = codexSupervisor();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() =>
    expect(existsSync(join(crewKeeperDir(dbPath, runId), "keeper.pid"))).toBe(true),
  );
  await sup.endRunByEngine(runId);
});

describe("a restart attaches to the workspace", () => {
  it("keeps an idle row idle", async () => {
    const { state, first } = await idleRun();
    await restart(state, first);
    await until(() =>
      expect(calls(state).filter((c) => c[0] === "sessions").length).toBeGreaterThan(3),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(seatState("guido-1")).toBe("idle");
    expect(calls(state).filter((c) => c[0] === "new-workspace")).toHaveLength(1);
  });

  it("keeps a needs-input row waiting, then runs when cmux runs", async () => {
    const { state, first } = await idleRun();
    setLifecycle(state, "needsInput");
    await until(() => expect(seatState("guido-1")).toBe("needs-input"));
    await restart(state, first);
    await new Promise((r) => setTimeout(r, 1500));
    expect(seatState("guido-1")).toBe("needs-input");
    setLifecycle(state, "running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
  });

  it("a saved needs-input row becomes running when cmux is already running", async () => {
    const { state, first } = await idleRun();
    setLifecycle(state, "needsInput");
    await until(() => expect(seatState("guido-1")).toBe("needs-input"));
    await first.sup.stopAll();
    setLifecycle(state, "running");
    const next = make({ cmuxCommand: [process.execPath, fake, state] });
    next.sup.start();
    await until(() => expect(seatState("guido-1")).toBe("running"));
  });

  it("closes a workspace restored with a new pid before it resumes", async () => {
    const { state, first } = await idleRun();
    const old = sessions(state)[0]?.workspace_id;
    await first.sup.stopAll();
    edit(state, (session) => {
      session.pid = 2;
    });
    const next = make({ cmuxCommand: [process.execPath, fake, state] });
    next.sup.start();
    await until(() => expect(calls(state).filter((c) => c[0] === "new-workspace")).toHaveLength(2));
    const all = calls(state);
    const closed = all.findIndex(
      (c) => c[0] === "close-workspace" && c.includes(old as string) && c.includes("--force"),
    );
    expect(closed).toBeGreaterThan(-1);
    expect(closed).toBeLessThan(all.findLastIndex((c) => c[0] === "new-workspace"));
  });

  it("closes a workspace saved before Claude registered, then resumes in a new one", async () => {
    const { state, first, run } = await idleRun();
    const old = sessions(state)[0]?.workspace_id;
    await first.sup.stopAll();
    // the hub went down in the startup window: the setting holds no pid yet
    store.setSetting(`cmux.workspace:${run.runId}`, JSON.stringify({ workspace: old, pid: null }));
    const next = make({ cmuxCommand: [process.execPath, fake, state] });
    next.sup.start();
    await until(() => expect(calls(state).filter((c) => c[0] === "new-workspace")).toHaveLength(2));
    const all = calls(state);
    const closed = all.findIndex((c) => c[0] === "close-workspace" && c.includes(old as string));
    expect(closed).toBeGreaterThan(-1);
    expect(closed).toBeLessThan(all.findLastIndex((c) => c[0] === "new-workspace"));
  });

  it("a saved running row does not start a second turn", async () => {
    const { state, first } = await idleRun();
    setLifecycle(state, "running");
    await until(() => expect(seatState("guido-1")).toBe("running"));
    const started = store.seatSession("guido-1")?.lastTurnStartedAt;
    await restart(state, first);
    await new Promise((r) => setTimeout(r, 1500));
    expect(seatState("guido-1")).toBe("running");
    expect(store.seatSession("guido-1")?.lastTurnStartedAt).toBe(started);
  });

  it("does not replay transcript lines it already copied", async () => {
    const { state, first, run } = await idleRun();
    const source = join(dir, "claude-source.jsonl");
    writeFileSync(source, '{"type":"assistant","n":"one"}\n');
    edit(state, (session) => {
      session.transcript_path = source;
    });
    const copied = (marker: string) =>
      readFileSync(store.run(run.runId)?.transcriptPath ?? "", "utf8").split(marker).length - 1;
    await until(() => expect(copied('"n":"one"')).toBe(1));
    await restart(state, first);
    appendFileSync(source, '{"type":"assistant","n":"two"}\n');
    await until(() => expect(copied('"n":"two"')).toBe(1));
    expect(copied('"n":"one"')).toBe(1);
  });
});

describe.each([
  ["denied", CMUX_REFUSED_TEXT],
  ["down", CMUX_DOWN_TEXT],
])("a start with cmux %s", (ping, text) => {
  it("is a 409 with the setup text and leaves the seat idle with no run", async () => {
    const state = join(dir, "fake-cmux.json");
    writeFileSync(state, JSON.stringify({ sessions: [], calls: [], ping }));
    const { sup } = make({
      cmuxCommand: [process.execPath, fake, state],
      cmuxOptions: { open: ["/usr/bin/true"], waitMs: 600 },
    });
    sup.start();
    await expect(sup.startRun("guido-1", 42)).rejects.toMatchObject({ status: 409, message: text });
    expect(calls(state).some((c) => c[0] === "new-workspace")).toBe(false);
    const noReport = () => store.notes().filter((n) => n.key.startsWith("no_report:"));
    expect(noReport()).toEqual([]);
    // the engine's next try gets the same answer, and makes no run and no flag
    await expect(sup.startRun("guido-1", 42)).rejects.toMatchObject({ status: 409, message: text });
    expect(noReport()).toEqual([]);
    expect(calls(state).some((c) => c[0] === "new-workspace")).toBe(false);
    expect(store.seatSession("guido-1")).toMatchObject({
      state: "idle",
      reason: text,
      runId: null,
      cliSessionId: null,
      worktree: null,
    });
  });
});
