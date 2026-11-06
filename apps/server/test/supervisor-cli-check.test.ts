import "./supervisor-harness.ts";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CliHold } from "../src/cli-update.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import {
  clone,
  dir,
  git,
  make,
  recorded,
  recordFile,
  root,
  store,
  until,
} from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

const BROKEN = fileURLToPath(new URL("./fixtures/fake-claude-seat-broken.mjs", import.meta.url));
const second = {
  id: "guido-2",
  role: "GUIDO",
  accountId: "claude-main",
  model: "haiku",
  area: ["apps/**"],
};
/** Every worktree the crew folder holds (a check must leave none). */
const worktrees = () => (existsSync(root) ? readdirSync(root) : []);

it("starts a seat through the real start path, reads the nonce and leaves nothing behind", async () => {
  const { sup } = make();
  sup.start();
  const result = await sup.checkCli("claude");
  expect(result).toMatchObject({ kind: "ran", ok: true });
  // the seat's own start: its MCP config is on the command line, and it ran in the throwaway worktree
  const start = recorded()[0];
  expect(start.argv).toContain("--mcp-config");
  expect(start.cwd).toContain("guido-1-cli-check");
  // nothing is left: the seat is idle with no run, and the worktree is gone
  expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
  expect(worktrees().filter((n) => n.includes("cli-check"))).toEqual([]);
  expect(existsSync(start.cwd)).toBe(false);
  // and the seat takes its next run as ever, on the same command
  await sup.startRun("guido-1", 42);
  await until(() => expect(recorded().filter((l) => l.argv).length).toBe(2));
  expect(recorded().filter((l) => l.argv)[1].argv).toContain("--mcp-config");
});

it("fails a version that starts bare but breaks under the seat's config, and frees the seat", async () => {
  const { sup } = make({ fake: BROKEN });
  sup.start();
  const result = await sup.checkCli("claude");
  expect(result).toMatchObject({ kind: "ran", ok: false });
  expect(JSON.stringify(result)).toMatch(/invalid seat settings/);
  expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
  expect(worktrees().filter((n) => n.includes("cli-check"))).toEqual([]);
  // no "ended without a report" note: the check's own answer is the only word
  expect(store.notes().filter((n) => n.seatId === "guido-1")).toEqual([]);
});

it("is not stopped by the CLI hold the update itself keeps", async () => {
  const cliHold = new CliHold();
  cliHold.hold("claude CLI 2.0.1 has not passed its live check", "cli-auto:claude");
  const { sup } = make({ cliHold });
  sup.start();
  expect(await sup.checkCli("claude")).toMatchObject({ kind: "ran", ok: true });
  // a real run is still refused while it is held
  await expect(sup.startRun("guido-1", 42)).rejects.toMatchObject({ status: 409 });
});

it("never starts on a seat that holds a run: busy when it is the only one", async () => {
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  const before = recorded().filter((l) => l.argv).length;
  expect(await sup.checkCli("claude")).toEqual({ kind: "busy" });
  expect(recorded().filter((l) => l.argv)).toHaveLength(before);
  expect(store.seatSession("guido-1")?.runId).toBe(runId);
  expect(store.run(runId)?.endedAt).toBeNull();
});

it("uses another idle seat when one holds a run, and leaves the busy seat's worktree alone", async () => {
  const { sup } = make({ extraSeat: second });
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  const worktree = store.seatSession("guido-1")?.worktree ?? "";
  expect(await sup.checkCli("claude")).toMatchObject({ kind: "ran", ok: true });
  const starts = recorded().filter((l) => l.argv);
  expect(starts[1].cwd).toContain("guido-2-cli-check");
  expect(starts[1].cwd).not.toBe(worktree);
  expect(store.seatSession("guido-1")).toMatchObject({ runId, worktree });
  expect(existsSync(worktree)).toBe(true);
  expect(store.run(runId)?.endedAt).toBeNull();
});

it("has no seat to try for a vendor no seat is configured for", async () => {
  const { sup } = make();
  sup.start();
  expect(await sup.checkCli("codex")).toEqual({ kind: "no-seat" });
});

it("does not call a failure before the CLI starts a failed version (the fetch cannot reach origin)", async () => {
  const { sup } = make();
  sup.start();
  git(clone, "remote", "set-url", "origin", join(dir, "no-such-remote.git"));
  const result = await sup.checkCli("claude");
  expect(result.kind).toBe("unproven");
  expect(recorded().filter((l) => l.argv)).toEqual([]);
  expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
  expect(worktrees().filter((n) => n.includes("cli-check"))).toEqual([]);
});

it("ends a check a restart cut off, instead of adopting it as the seat's run", async () => {
  writeFileSync(`${recordFile}.hold`, "");
  const first = make();
  first.sup.start();
  const checking = first.sup.checkCli("claude");
  await until(() => expect(store.seatSession("guido-1")?.runId).toBeTruthy());
  const runId = store.seatSession("guido-1")?.runId as string;
  const cwd = store.seatSession("guido-1")?.worktree as string;
  expect(existsSync(cwd)).toBe(true);

  // the hub restarts: a second supervisor on the same store takes the crew over
  const second = make();
  second.sup.start();
  await until(() => expect(store.run(runId)?.endedAt).not.toBeNull());
  await until(() =>
    expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null }),
  );
  await until(() => expect(existsSync(cwd)).toBe(false));
  expect(store.notes().filter((n) => n.seatId === "guido-1")).toEqual([]);
  expect(store.getSetting("cli-check-run:guido-1")).toBeNull();

  writeFileSync(`${recordFile}.go`, "");
  await checking.catch(() => {});
});

it("passes a Codex seat through the app-server and leaves the seat idle", async () => {
  const { sup } = codexSupervisor({ checkRead: true });
  sup.start();
  expect(await sup.checkCli("codex")).toMatchObject({ kind: "ran", ok: true });
  expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
  expect(worktrees().filter((n) => n.includes("cli-check"))).toEqual([]);
});

it("fails a Codex turn that ends failed", async () => {
  const { sup } = codexSupervisor({ checkRead: true, failed: true });
  sup.start();
  expect(await sup.checkCli("codex")).toMatchObject({ kind: "ran", ok: false });
  expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
});
