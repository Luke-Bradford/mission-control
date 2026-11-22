import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dir, make, seatState, store, until } from "./supervisor-harness.ts";

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

it("starts a Claude run in a cmux workspace", async () => {
  const state = join(dir, "fake-cmux.json");
  files.push(state);
  const { sup } = make({ cmuxCommand: [process.execPath, fake, state] });
  sup.start();
  await sup.startRun("guido-1", 42);
  await until(() => seatState("guido-1") === "idle");
  const created = JSON.parse(readFileSync(state, "utf8")).sessions[0];
  expect(created.cwd).toContain("worktrees");
  const launcher = readFileSync(created.command, "utf8");
  expect(launcher).toContain("--settings");
  expect(launcher).not.toContain("--setting-sources");
  expect(launcher).toContain("--mcp-config");
  expect(launcher).toContain("--strict-mcp-config");
  expect(launcher).toContain("--session-id");
  expect(launcher).not.toContain(" -p ");
  await until(() =>
    expect(
      JSON.parse(readFileSync(state, "utf8")).calls.some((call: string[]) => call[0] === "send"),
    ).toBe(true),
  );
  const sent = JSON.parse(readFileSync(state, "utf8")).calls.find(
    (call: string[]) => call[0] === "send",
  );
  expect(sent.at(-1)).toMatch(/^Mission Control sent you a message\. Read .+ and act on it\.$/);
});

it("seat state follows cmux and /clear keeps the run", async () => {
  const state = join(dir, "fake-cmux.json");
  const { sup } = make({ cmuxCommand: [process.execPath, fake, state] });
  sup.start();
  const run = await sup.startRun("guido-1", 42);
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
