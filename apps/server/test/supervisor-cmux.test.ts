import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dir, make, seatState, until } from "./supervisor-harness.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-cmux.mjs", import.meta.url));
const files: string[] = [];
afterEach(() => files.splice(0));
beforeEach(() => vi.stubEnv("TMPDIR", dir));
afterEach(() => vi.unstubAllEnvs());

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
  expect(launcher).toContain("--mcp-config");
  expect(launcher).toContain("--strict-mcp-config");
  expect(launcher).toContain("--session-id");
  expect(launcher).not.toContain(" -p ");
  await until(() =>
    JSON.parse(readFileSync(state, "utf8")).calls.some((call: string[]) => call[0] === "send"),
  );
  const sent = JSON.parse(readFileSync(state, "utf8")).calls.find(
    (call: string[]) => call[0] === "send",
  );
  expect(sent.at(-1)).toMatch(/^Mission Control sent you a message\. Read .+ and act on it\.$/);
});
