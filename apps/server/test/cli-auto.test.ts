import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import {
  autoUpdateCli,
  CLI_CHECK_WAIT_MAX_MS,
  type CliToolOps,
  cliUpdateKind,
  heldCliVersion,
  npmPrefix,
  pendingCliUpdate,
  realCliOps,
  type SeatCheck,
  settlePending,
} from "../src/cli/auto.ts";
import { CLI_RETRY_MS, CliHold, type ExecFn } from "../src/cli/update.ts";
import type { CcConfig } from "../src/config.ts";
import { createScheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let hold: CliHold;
let lines: string[];
const NOW = Date.UTC(2026, 10, 6, 12);

/** A fake version source: the registry's latest, what is installed, and which versions fail the live check. */
function fakeOps(start: string, latest: string, bad: string[] = []) {
  const state = { installed: start, latest, installs: [] as string[], checks: [] as string[] };
  const ops: CliToolOps = {
    latest: async () => state.latest,
    installed: async () => state.installed,
    install: async (v) => {
      state.installs.push(v);
      state.installed = v;
      return { ok: true };
    },
    check: async (v) => {
      state.checks.push(v);
      return bad.includes(v)
        ? { ok: false, detail: `boom: ${v} cannot read a file` }
        : { ok: true, detail: "version and tool call answered" };
    },
  };
  return { state, ops };
}

const run = (tool: "claude" | "codex", ops: CliToolOps) =>
  autoUpdateCli(tool, ops, { store, hold, log: (l) => lines.push(l), now: () => NOW });
const items = () => store.audit(NOW - 1000, NOW + 1000).items ?? [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-cli-auto-"));
  store = new Store(join(dir, "mc.sqlite"));
  hold = new CliHold();
  lines = [];
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("autoUpdateCli", () => {
  it("lands a minor update that passes the live check, releases the hold and logs each step", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.2.0");
    const released: string[] = [];
    hold.onRelease(() => released.push("released"));
    expect(await run("claude", ops)).toBe("applied");
    expect(state.installed).toBe("2.2.0");
    expect(state.checks).toEqual(["2.2.0"]);
    expect(hold.reason).toBeNull();
    expect(released).toEqual(["released"]);
    expect(lines.join("\n")).toMatch(/claude: 2\.1\.0 -> 2\.2\.0.*installing/s);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => /live check passed/.test(l))).toBe(true);
    expect(items()).toMatchObject([
      { kind: "cli-update", subject: "claude@2.2.0", tier: "auto", state: "done" },
    ]);
    expect(store.notes().filter((n) => n.clearedAt === null)).toEqual([]);
  });

  it("holds new runs while it installs and checks", async () => {
    const { ops } = fakeOps("1.0.0", "1.0.1");
    const seen: (string | null)[] = [];
    const wrapped: CliToolOps = {
      ...ops,
      check: async (v) => {
        seen.push(hold.reason);
        return ops.check(v);
      },
    };
    await run("codex", wrapped);
    expect(seen[0]).toMatch(/codex/);
    expect(hold.reason).toBeNull();
  });

  it("does nothing when the installed version is current or newer", async () => {
    const { state, ops } = fakeOps("2.2.0", "2.2.0");
    expect(await run("claude", ops)).toBe("current");
    state.latest = "2.1.9";
    expect(await run("claude", ops)).toBe("current");
    expect(state.installs).toEqual([]);
    expect(items()).toEqual([]);
  });

  it("rolls a bad version back, keeps the previous one in use, holds it and raises one item", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1", ["2.1.1"]);
    expect(await run("claude", ops)).toBe("rolled-back");
    expect(state.installs).toEqual(["2.1.1", "2.1.0"]);
    expect(state.installed).toBe("2.1.0");
    expect(hold.reason).toBeNull();
    expect(heldCliVersion(store, "claude")).toBe("2.1.1");
    const open = store.notes().filter((n) => n.clearedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].text).toMatch(/claude CLI 2\.1\.1 failed.*boom.*rolled back to 2\.1\.0/s);
    expect(items()).toMatchObject([
      { kind: "cli-update-failed", subject: "claude@2.1.1", tier: "flight", state: "open" },
    ]);
    expect(lines.some((l) => /rolled back/.test(l))).toBe(true);

    // the same version is not tried again, and no second item appears
    expect(await run("claude", ops)).toBe("held");
    expect(await run("claude", ops)).toBe("held");
    expect(state.installs).toEqual(["2.1.1", "2.1.0"]);
    expect(store.notes().filter((n) => n.clearedAt === null)).toHaveLength(1);
    expect(items()).toHaveLength(1);

    // a newer version is tried, and when it passes the earlier item's note is cleared
    state.latest = "2.1.2";
    expect(await run("claude", ops)).toBe("applied");
    expect(state.installed).toBe("2.1.2");
    expect(store.notes().filter((n) => n.clearedAt === null)).toEqual([]);
  });

  it("keeps runs held and says so when the rollback itself fails", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1", ["2.1.1"]);
    const failing: CliToolOps = {
      ...ops,
      install: async (v) => (v === "2.1.0" ? { ok: false, error: "network down" } : ops.install(v)),
    };
    expect(await run("claude", failing)).toBe("rollback-failed");
    expect(state.installed).toBe("2.1.1");
    expect(hold.reason).toMatch(/claude/);
    expect(store.notes().filter((n) => n.clearedAt === null)).toHaveLength(1);
  });

  it("treats a failed install as a failed update and restores the previous version", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1");
    const failing: CliToolOps = {
      ...ops,
      install: async (v) => {
        state.installs.push(v);
        if (v === "2.1.1") {
          state.installed = "2.1.1";
          return { ok: false, error: "EACCES" };
        }
        state.installed = v;
        return { ok: true };
      },
    };
    expect(await run("codex", failing)).toBe("rolled-back");
    expect(state.installed).toBe("2.1.0");
    expect(state.checks).toEqual([]);
    expect(heldCliVersion(store, "codex")).toBe("2.1.1");
  });

  it("fails the update when the installed version is not the one asked for", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1");
    const liar: CliToolOps = {
      ...ops,
      install: async (v) => {
        state.installs.push(v);
        return { ok: true };
      },
    };
    expect(await run("claude", liar)).toBe("rolled-back");
    expect(state.installed).toBe("2.1.0");
  });

  it("never installs a major version by itself, and records one go-ahead item", async () => {
    const { state, ops } = fakeOps("2.9.0", "3.0.0");
    expect(await run("claude", ops)).toBe("major");
    expect(await run("claude", ops)).toBe("major");
    expect(state.installs).toEqual([]);
    expect(state.checks).toEqual([]);
    expect(items()).toMatchObject([
      { kind: "cli-update-major", subject: "claude@3.0.0", tier: "go-ahead", state: "open" },
    ]);
  });

  it("treats a 0.x minor step as a minor update for codex, a 1.0 step as a major one", async () => {
    const a = fakeOps("0.40.0", "0.41.0");
    expect(await run("codex", a.ops)).toBe("applied");
    const b = fakeOps("0.41.0", "1.0.0");
    expect(await run("codex", b.ops)).toBe("major");
    expect(b.state.installs).toEqual([]);
  });

  it.each([
    ["a pre-release", "2.2.0-beta.1"],
    ["a shell metacharacter", "2.2.0; rm -rf /"],
    ["junk", "latest"],
  ])("ignores %s from the version source", async (_n, latest) => {
    const { state, ops } = fakeOps("2.1.0", latest);
    expect(await run("claude", ops)).toBe("current");
    expect(state.installs).toEqual([]);
  });

  it("does nothing when the tool is not installed or the source does not answer", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.2.0");
    expect(await run("claude", { ...ops, installed: async () => null })).toBe("current");
    expect(await run("claude", { ...ops, latest: async () => null })).toBe("current");
    expect(state.installs).toEqual([]);
  });

  it("updates while another path holds runs, and leaves that hold alone", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.2.0");
    hold.hold("claude CLI failed its smoke test", "cli:claude");
    expect(await run("codex", ops)).toBe("applied");
    expect(state.installed).toBe("2.2.0");
    expect(hold.reason).toBe("claude CLI failed its smoke test");
    // and the other way: a later release by that path leaves this update's hold in place
    const slow = fakeOps("1.0.0", "1.0.1");
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting: CliToolOps = {
      ...slow.ops,
      check: async (v) => {
        await gate;
        return slow.ops.check(v);
      },
    };
    const pass = run("codex", waiting);
    await vi.waitFor(() => expect(hold.heldBy("cli-auto:codex")).toBe(true));
    hold.release("cli:claude");
    expect(hold.reason).toMatch(/codex/);
    release();
    expect(await pass).toBe("applied");
    expect(hold.reason).toBeNull();
  });

  it("does not hold runs when a failed install changed nothing (the working version never left)", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1");
    const down: CliToolOps = {
      ...ops,
      install: async (v) => {
        state.installs.push(v);
        return { ok: false, error: "network down" };
      },
    };
    expect(await run("claude", down)).toBe("rolled-back");
    expect(state.installs).toEqual(["2.1.1"]);
    expect(state.installed).toBe("2.1.0");
    expect(hold.reason).toBeNull();
    expect(heldCliVersion(store, "claude")).toBe("2.1.1");
    expect(store.notes().filter((n) => n.clearedAt === null)).toHaveLength(1);
  });

  it("checks a version a restart left unproven before anything runs on it", async () => {
    const { state, ops } = fakeOps("2.2.0", "2.2.0", []);
    store.setSetting("cli-auto-pending:claude", JSON.stringify({ from: "2.1.0", to: "2.2.0" }));
    expect(pendingCliUpdate(store, "claude")).toEqual({ from: "2.1.0", to: "2.2.0" });
    expect(await run("claude", ops)).toBe("applied");
    expect(state.checks).toEqual(["2.2.0"]);
    expect(pendingCliUpdate(store, "claude")).toBeNull();
    expect(hold.reason).toBeNull();

    // and one that fails is rolled back to the version before it
    const bad = fakeOps("2.3.0", "2.3.0", ["2.3.0"]);
    store.setSetting("cli-auto-pending:codex", JSON.stringify({ from: "2.2.0", to: "2.3.0" }));
    expect(await run("codex", bad.ops)).toBe("rolled-back");
    expect(bad.state.installed).toBe("2.2.0");
    expect(heldCliVersion(store, "codex")).toBe("2.3.0");
  });

  it("keeps the update pending after a failed rollback, and tries the rollback again next pass", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1", ["2.1.1"]);
    let broken = true;
    const flaky: CliToolOps = {
      ...ops,
      install: async (v) =>
        v === "2.1.0" && broken ? { ok: false, error: "EACCES" } : ops.install(v),
    };
    expect(await run("claude", flaky)).toBe("rollback-failed");
    expect(pendingCliUpdate(store, "claude")).toMatchObject({ from: "2.1.0", to: "2.1.1" });
    expect(hold.heldBy("cli-auto:claude")).toBe(true);
    broken = false;
    expect(await run("claude", flaky)).toBe("rolled-back");
    expect(state.installed).toBe("2.1.0");
    expect(hold.reason).toBeNull();
    expect(pendingCliUpdate(store, "claude")).toBeNull();
  });

  it("serves the tier of each item through the audit view", async () => {
    await run("claude", fakeOps("2.1.0", "2.2.0").ops);
    await run("codex", fakeOps("0.1.0", "0.1.1", ["0.1.1"]).ops);
    await run("claude", fakeOps("2.2.0", "3.0.0").ops);
    const view: AuditView = store.audit(NOW - 1000, NOW + 1000);
    const tiers = Object.fromEntries((view.items ?? []).map((i) => [i.kind, i.tier]));
    expect(tiers).toEqual({
      "cli-update": "auto",
      "cli-update-failed": "flight",
      "cli-update-major": "go-ahead",
    });
  });

  it("gives an item of an unknown kind the Go-ahead tier", () => {
    store.recordAuditItem({
      kind: "brand-new",
      subject: "x",
      state: "open",
      detail: "",
      at: NOW,
    });
    expect(items()[0]).toMatchObject({ kind: "brand-new", tier: "go-ahead" });
  });

  it("names the item kind from the step size", () => {
    expect(cliUpdateKind("2.1.0", "2.1.9")).toBe("cli-update");
    expect(cliUpdateKind("2.1.0", "2.9.0")).toBe("cli-update");
    expect(cliUpdateKind("2.1.0", "3.0.0")).toBe("cli-update-major");
    expect(cliUpdateKind("0.9.0", "0.10.0")).toBe("cli-update");
  });
});

describe("realCliOps", () => {
  const PREFIX = "/opt/npm";
  const record = (answers: (file: string, args: readonly string[]) => string | null = () => "") => {
    const calls: { file: string; args: string[]; cwd?: string }[] = [];
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ file, args: [...args], cwd: opts.cwd });
      const out = answers(file, args);
      return out === null
        ? { code: 1, stdout: "", stderr: "failed" }
        : { code: 0, stdout: out, stderr: "" };
    };
    return { exec, calls };
  };

  it("reads the latest version from the registry and the installed one from --version", async () => {
    const { exec, calls } = record((file) => (file === "npm" ? "2.3.4\n" : "codex-cli 0.155.0\n"));
    expect(await realCliOps("claude", exec, PREFIX).latest()).toBe("2.3.4");
    expect(calls[0]).toMatchObject({
      file: "npm",
      args: ["view", "@anthropic-ai/claude-code", "version"],
    });
    expect(await realCliOps("codex", exec, PREFIX).installed()).toBe("0.155.0");
  });

  it("installs one exact version with no shell, and refuses a version that is not x.y.z", async () => {
    const { exec, calls } = record();
    expect(await realCliOps("codex", exec, PREFIX).install("0.5.7")).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      file: "npm",
      args: ["--prefix", PREFIX, "install", "-g", "@openai/codex@0.5.7"],
    });
    expect((await realCliOps("codex", exec, PREFIX).install("0.5.7 --foo")).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("passes the live check only when the version matches and a tool call returned the nonce", async () => {
    const calls: { args: string[]; cwd?: string }[] = [];
    const exec: ExecFn = async (_file, args, opts) => {
      calls.push({ args: [...args], cwd: opts.cwd });
      if (args[0] === "--version") return { code: 0, stdout: "2.3.4 (Claude Code)\n", stderr: "" };
      const name = /check-[a-f0-9]+\.txt/.exec(args.at(-1) ?? "")?.[0] ?? "";
      return { code: 0, stdout: readFileSync(join(opts.cwd ?? "", name), "utf8"), stderr: "" };
    };
    expect((await realCliOps("claude", exec, PREFIX).check("2.3.4")).ok).toBe(true);
    // the variadic --allowedTools must not sit before the prompt, or it swallows it
    expect(calls[1].args).toEqual([
      "-p",
      "--model",
      "haiku",
      "--allowedTools=Read",
      expect.stringMatching(/^Read the file check-[a-f0-9]+\.txt /),
    ]);
    expect(calls[1].cwd).toBeDefined();

    // a model that only answers, without the tool call, fails
    const guess = record((_f, args) => (args[0] === "--version" ? "2.3.4 (Claude Code)\n" : "OK"));
    expect((await realCliOps("claude", guess.exec, PREFIX).check("2.3.4")).ok).toBe(false);
    const wrongVersion = record(() => "9.9.9 (Claude Code)\n");
    expect((await realCliOps("claude", wrongVersion.exec, PREFIX).check("2.3.4")).ok).toBe(false);
    expect(wrongVersion.calls).toHaveLength(1);
  });

  it("fails a codex under the seat floor before it runs anything", async () => {
    const low = record(() => "codex-cli 0.5.6\n");
    const r = await realCliOps("codex", low.exec, PREFIX).check("0.5.6");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/floor/);
    expect(low.calls).toHaveLength(1);
  });

  it("passes when the answer holds the nonce the harness wrote", async () => {
    const { exec, calls } = record((_f, args) => {
      if (args[0] === "--version") return "codex-cli 0.155.0\n";
      return "token ".concat(
        // echo back whatever nonce file the harness wrote, as a tool call would
        readFileSync(
          join(calls.at(-1)?.cwd ?? "", /check-[a-f0-9]+\.txt/.exec(args.at(-1) ?? "")?.[0] ?? ""),
          "utf8",
        ),
      );
    });
    const r = await realCliOps("codex", exec, PREFIX).check("0.155.0");
    expect(r.ok).toBe(true);
  });
});

describe("the live check through a seat's start path", () => {
  const PREFIX = "/opt/npm";
  /** An npm-and-CLI fake: `npm install` changes the version `--version` prints; a bare `-p` check answers fine. */
  function npmWorld(start: string, latest: string) {
    const world = { version: start, bare: 0 };
    const exec: ExecFn = async (file, args, opts) => {
      if (file === "npm" && args[0] === "view")
        return { code: 0, stdout: `${latest}\n`, stderr: "" };
      if (file === "npm") {
        world.version = /@(\d+\.\d+\.\d+)$/.exec(args.at(-1) ?? "")?.[1] ?? world.version;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--version")
        return { code: 0, stdout: `${world.version} (Claude Code)\n`, stderr: "" };
      // a bare `claude -p`: answers the nonce the harness wrote, whatever a seat's config says
      world.bare++;
      const name = /check-[a-f0-9]+\.txt/.exec(args.at(-1) ?? "")?.[0] ?? "";
      return { code: 0, stdout: readFileSync(join(opts.cwd ?? "", name), "utf8"), stderr: "" };
    };
    return { world, exec };
  }
  const pass = (ops: CliToolOps) => run("claude", ops);

  it("fails, rolls back, holds the version and raises one item for a version that breaks only under a seat's config", async () => {
    const { world, exec } = npmWorld("2.1.0", "2.1.1");
    // the bare check passes this very version (the narrower check this replaces)
    const bare = npmWorld("2.1.0", "2.1.1");
    expect(await pass(realCliOps("claude", bare.exec, PREFIX))).toBe("applied");
    store.deleteSetting("cli-auto-pending:claude");
    store.deleteSetting("cli-auto-held:claude");
    for (const i of store.audit(NOW - 1000, NOW + 1000).items ?? []) expect(i.state).toBe("done");

    const seatCheck: SeatCheck = vi.fn(async () => ({
      kind: "ran" as const,
      ok: false,
      detail: "Error: invalid seat settings (unknown key in mcp config)",
    }));
    expect(await pass(realCliOps("claude", exec, PREFIX, undefined, seatCheck))).toBe(
      "rolled-back",
    );
    expect(seatCheck).toHaveBeenCalledWith("claude");
    expect(world.version).toBe("2.1.0");
    expect(world.bare).toBe(0);
    expect(heldCliVersion(store, "claude")).toBe("2.1.1");
    expect(hold.reason).toBeNull();
    const open = store.notes().filter((n) => n.clearedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].text).toMatch(/2\.1\.1 failed.*invalid seat settings.*rolled back to 2\.1\.0/s);
    const failed = (store.audit(NOW - 1000, NOW + 1000).items ?? []).filter(
      (i) => i.kind === "cli-update-failed",
    );
    expect(failed).toHaveLength(1);
    // the held version is not tried again
    expect(await pass(realCliOps("claude", exec, PREFIX, undefined, seatCheck))).toBe("held");
    expect(seatCheck).toHaveBeenCalledTimes(1);
  });

  it("keeps a version that passes through a seat, without the bare check", async () => {
    const { world, exec } = npmWorld("2.1.0", "2.1.1");
    const seatCheck: SeatCheck = async () => ({ kind: "ran", ok: true, detail: "fine" });
    expect(await pass(realCliOps("claude", exec, PREFIX, undefined, seatCheck))).toBe("applied");
    expect(world.version).toBe("2.1.1");
    expect(world.bare).toBe(0);
    expect(hold.reason).toBeNull();
    expect(items()).toMatchObject([{ kind: "cli-update", state: "done" }]);
  });

  it("does not run a seat check on a version that fails --version or the codex floor", async () => {
    const seatCheck = vi.fn(async () => ({ kind: "ran" as const, ok: true, detail: "" }));
    const lie: ExecFn = async () => ({ code: 0, stdout: "9.9.9\n", stderr: "" });
    expect((await realCliOps("claude", lie, PREFIX, undefined, seatCheck).check("2.3.4")).ok).toBe(
      false,
    );
    const low: ExecFn = async () => ({ code: 0, stdout: "codex-cli 0.5.6\n", stderr: "" });
    expect((await realCliOps("codex", low, PREFIX, undefined, seatCheck).check("0.5.6")).ok).toBe(
      false,
    );
    expect(seatCheck).not.toHaveBeenCalled();
  });

  it("waits, held and unchanged, while every seat is busy, and proves the version on a later pass", async () => {
    const { world, exec } = npmWorld("2.1.0", "2.1.1");
    let answer: Awaited<ReturnType<SeatCheck>> = { kind: "busy" };
    const seatCheck: SeatCheck = async () => answer;
    const ops = realCliOps("claude", exec, PREFIX, undefined, seatCheck);
    expect(await pass(ops)).toBe("waiting");
    // nothing was rolled back, held back or raised; runs stay held on the new version
    expect(world.version).toBe("2.1.1");
    expect(hold.reason).toMatch(/claude CLI 2\.1\.1 has not passed/);
    expect(heldCliVersion(store, "claude")).toBeNull();
    expect(pendingCliUpdate(store, "claude")).toMatchObject({ from: "2.1.0", to: "2.1.1" });
    expect(store.notes()).toEqual([]);
    expect(items()).toEqual([]);

    answer = { kind: "ran", ok: true, detail: "fine" };
    expect(await pass(ops)).toBe("applied");
    expect(world.version).toBe("2.1.1");
    expect(hold.reason).toBeNull();
    expect(pendingCliUpdate(store, "claude")).toBeNull();
    expect(items()).toMatchObject([{ kind: "cli-update", state: "done" }]);
  });

  it("gives the previous version back, unheld and unflagged, when the check cannot run for too long", async () => {
    const { world, exec } = npmWorld("2.1.0", "2.1.1");
    const seatCheck: SeatCheck = async () => ({ kind: "busy" });
    const ops = realCliOps("claude", exec, PREFIX, undefined, seatCheck);
    let at = NOW;
    const at$ = () =>
      autoUpdateCli("claude", ops, { store, hold, log: (l) => lines.push(l), now: () => at });
    expect(await at$()).toBe("waiting");
    at += CLI_CHECK_WAIT_MAX_MS - 1;
    expect(await at$()).toBe("waiting");
    expect(hold.reason).not.toBeNull();
    at += 1;
    expect(await at$()).toBe("gave-up");
    expect(world.version).toBe("2.1.0");
    expect(hold.reason).toBeNull();
    expect(heldCliVersion(store, "claude")).toBeNull();
    expect(pendingCliUpdate(store, "claude")).toBeNull();
    expect(store.notes()).toEqual([]);
    expect(items()).toEqual([]);
    expect(lines.some((l) => /trying again later/.test(l))).toBe(true);
  });

  it("treats a check that failed before the CLI started as unproven: it waits, with no held version and no note", async () => {
    const { world, exec } = npmWorld("2.1.0", "2.1.1");
    const seatCheck: SeatCheck = async () => ({ kind: "unproven", detail: "git fetch failed" });
    expect(await pass(realCliOps("claude", exec, PREFIX, undefined, seatCheck))).toBe("waiting");
    expect(world.version).toBe("2.1.1");
    expect(heldCliVersion(store, "claude")).toBeNull();
    expect(store.notes()).toEqual([]);
    expect(items()).toEqual([]);
    expect(lines.some((l) => /git fetch failed/.test(l))).toBe(true);
  });

  it("falls back to the bare check when no seat of the vendor is configured", async () => {
    const { world, exec } = npmWorld("2.1.0", "2.1.1");
    const seatCheck: SeatCheck = async () => ({ kind: "no-seat" });
    expect(await pass(realCliOps("claude", exec, PREFIX, undefined, seatCheck))).toBe("applied");
    expect(world.bare).toBe(1);
  });

  it("hands the scheduler's seat check to the collector's ops", async () => {
    const seen: (SeatCheck | undefined)[] = [];
    const seatCheck: SeatCheck = async () => ({ kind: "busy" });
    const scheduler = createScheduler({
      config: {
        operator: { id: "operator", timezone: "Europe/London" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
        updates: { hub: "off", cli: "between_runs" },
      },
      store,
      bus: new ChangeBus(),
      cliHold: hold,
      seatCheck,
      collectors: {
        cliOps: (_tool, check) => {
          seen.push(check);
          return null;
        },
      },
    });
    await scheduler.tick("cliAuto");
    expect(seen).toEqual([seatCheck, seatCheck]);
    await scheduler.stop();
  });
});

describe("the cliAuto job", () => {
  const config = (cli: "off" | "between_runs"): CcConfig => ({
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    updates: { hub: "off", cli },
  });
  const make = (cli: "off" | "between_runs", ops: Record<string, CliToolOps | null>) =>
    createScheduler({
      config: config(cli),
      store,
      bus: new ChangeBus(),
      cliHold: hold,
      log: (l) => lines.push(l),
      collectors: { cliOps: (tool) => ops[tool] ?? null },
    });

  it("updates each tool the collector offers when updates.cli is between_runs", async () => {
    const claude = fakeOps("2.1.0", "2.1.1");
    const codex = fakeOps("0.1.0", "0.2.0");
    const scheduler = make("between_runs", { claude: claude.ops, codex: codex.ops });
    expect(await scheduler.tick("cliAuto")).toBe("ran");
    expect(claude.state.installed).toBe("2.1.1");
    expect(codex.state.installed).toBe("0.2.0");
    await scheduler.stop();
  });

  it("re-checks a waiting update after CLI_RETRY_MS, and stop() cancels the armed re-check", async () => {
    vi.useFakeTimers();
    try {
      const { ops } = fakeOps("2.1.0", "2.1.1");
      let checks = 0;
      const waiting: CliToolOps = {
        ...ops,
        check: async (v) => {
          checks++;
          return checks === 1
            ? { ok: false, retry: true, detail: "every claude seat is busy" }
            : ops.check(v);
        },
      };
      const scheduler = make("between_runs", { claude: waiting });
      await scheduler.tick("cliAuto");
      expect(checks).toBe(1);
      expect(hold.reason).toMatch(/claude/);
      await vi.advanceTimersByTimeAsync(CLI_RETRY_MS);
      expect(checks).toBe(2);
      expect(hold.reason).toBeNull();
      expect(store.audit(0, Date.now() + 1000).items ?? []).toMatchObject([
        { kind: "cli-update", state: "done" },
      ]);
      await scheduler.stop();

      // a stopped scheduler does not re-check
      store.deleteSetting("cli-auto-pending:claude");
      const again = fakeOps("3.1.0", "3.1.1");
      let n = 0;
      const stuck: CliToolOps = {
        ...again.ops,
        check: async () => {
          n++;
          return { ok: false, retry: true, detail: "busy" };
        },
      };
      const second = make("between_runs", { claude: stuck });
      await second.tick("cliAuto");
      expect(n).toBe(1);
      await second.stop();
      await vi.advanceTimersByTimeAsync(CLI_RETRY_MS * 2);
      expect(n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when updates.cli is off", async () => {
    const claude = fakeOps("2.1.0", "2.1.1");
    const scheduler = make("off", { claude: claude.ops });
    await scheduler.tick("cliAuto");
    expect(claude.state.installs).toEqual([]);
    await scheduler.stop();
  });

  it("skips a tool the collector leaves to something else", async () => {
    const codex = fakeOps("0.1.0", "0.1.1");
    const scheduler = make("between_runs", { claude: null, codex: codex.ops });
    await scheduler.tick("cliAuto");
    expect(codex.state.installed).toBe("0.1.1");
    await scheduler.stop();
  });
});

describe("npmPrefix", () => {
  it("finds the prefix that owns a tool installed by npm, and nothing for any other install", () => {
    const prefix = join(dir, "npm");
    const bin = join(dir, "bin");
    mkdirSync(join(prefix, "lib", "node_modules", "@openai", "codex", "bin"), { recursive: true });
    mkdirSync(bin);
    const target = join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
    writeFileSync(target, "#!/bin/sh\n");
    symlinkSync(target, join(bin, "codex"));
    expect(npmPrefix("codex", bin)).toBe(realpathOf(prefix));

    const other = join(dir, "brew", "bin");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "claude"), "#!/bin/sh\n");
    expect(npmPrefix("claude", other)).toBeNull();
    expect(npmPrefix("claude", join(dir, "nowhere"))).toBeNull();
  });
});

describe("the hold during an update", () => {
  const config = (): CcConfig => ({
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    updates: { hub: "off", cli: "between_runs" },
  });

  it("survives the brew job passing its smoke test while the check is still running", async () => {
    const { ops, state } = fakeOps("0.1.0", "0.1.1");
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting: CliToolOps = {
      ...ops,
      check: async (v) => {
        await gate;
        return ops.check(v);
      },
    };
    const scheduler = createScheduler({
      config: config(),
      store,
      bus: new ChangeBus(),
      cliHold: hold,
      collectors: {
        cliOps: (tool) => (tool === "codex" ? waiting : null),
        cli: async () => ({
          cask: true,
          version: "2.0.0",
          upgraded: false,
          brewProblem: null,
          smokeFailure: null,
        }),
      },
    });
    const auto = scheduler.tick("cliAuto");
    await vi.waitFor(() => expect(state.installs).toEqual(["0.1.1"]));
    await scheduler.tick("cli");
    expect(hold.reason).toMatch(/codex/);
    release();
    await auto;
    expect(hold.reason).toBeNull();
    await scheduler.stop();
  });

  it("keeps a smoke-failure hold from the brew job when the update pass ends after it", async () => {
    const { ops } = fakeOps("0.1.0", "0.1.1");
    const scheduler = createScheduler({
      config: config(),
      store,
      bus: new ChangeBus(),
      cliHold: hold,
      collectors: {
        cliOps: (tool) => (tool === "codex" ? ops : null),
        cli: async () => ({
          cask: true,
          version: "2.0.0",
          upgraded: false,
          brewProblem: null,
          smokeFailure: "boom",
        }),
      },
    });
    await scheduler.tick("cli");
    await scheduler.tick("cliAuto");
    expect(hold.reason).toMatch(/smoke test/);
    await scheduler.stop();
  });

  it("holds runs at start when an update was begun and not settled", async () => {
    store.setSetting("cli-auto-pending:codex", JSON.stringify({ from: "0.1.0", to: "0.1.1" }));
    const { ops, state } = fakeOps("0.1.1", "0.1.1");
    const scheduler = createScheduler({
      config: config(),
      store,
      bus: new ChangeBus(),
      cliHold: hold,
      collectors: { cliOps: (tool) => (tool === "codex" ? ops : null) },
    });
    expect(hold.reason).toMatch(/codex/);
    await scheduler.tick("cliAuto");
    expect(state.checks).toEqual(["0.1.1"]);
    expect(hold.reason).toBeNull();
    await scheduler.stop();
  });
});

const realpathOf = (p: string) => realpathSync(p);

describe("a pending update the tool cannot settle", () => {
  it("retries the rollback while no version answers, and keeps runs held", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.1.1");
    const broken: CliToolOps = {
      ...ops,
      install: async (v) => {
        state.installs.push(v);
        state.installed = null as unknown as string;
        return { ok: false, error: "EACCES" };
      },
      installed: async () => state.installed,
    };
    expect(await run("claude", broken)).toBe("rollback-failed");
    expect(await run("claude", broken)).toBe("rollback-failed");
    expect(hold.heldBy("cli-auto:claude")).toBe(true);
    expect(pendingCliUpdate(store, "claude")).not.toBeNull();
    expect(state.installs).toEqual(["2.1.1", "2.1.0", "2.1.0"]);
    expect(store.notes().filter((n) => n.clearedAt === null)).toHaveLength(1);
  });

  it("settles a pending update for a tool now on PATH from another installer, and not one missing", () => {
    const bin = join(dir, "bin2");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    store.setSetting("cli-auto-pending:claude", JSON.stringify({ from: "2.1.0", to: "2.1.1" }));
    hold.hold("claude CLI 2.1.1 has not passed its live check", "cli-auto:claude");
    expect(settlePending(store, hold, "claude", (l) => lines.push(l), join(dir, "nowhere"))).toBe(
      false,
    );
    expect(hold.reason).not.toBeNull();
    expect(settlePending(store, hold, "claude", (l) => lines.push(l), bin)).toBe(true);
    expect(hold.reason).toBeNull();
    expect(pendingCliUpdate(store, "claude")).toBeNull();
    expect(lines.some((l) => /no longer an npm install/.test(l))).toBe(true);
  });

  it("lets the job settle it when cliOps no longer manages the tool", async () => {
    const bin = join(dir, "bin3");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    vi.stubEnv("PATH", bin);
    store.setSetting("cli-auto-pending:claude", JSON.stringify({ from: "2.1.0", to: "2.1.1" }));
    const scheduler = createScheduler({
      config: {
        operator: { id: "operator", timezone: "Europe/London" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
        updates: { hub: "off", cli: "between_runs" },
      },
      store,
      bus: new ChangeBus(),
      cliHold: hold,
      collectors: { cliOps: () => null },
    });
    expect(hold.reason).toMatch(/claude/);
    await scheduler.tick("cliAuto");
    expect(hold.reason).toBeNull();
    expect(pendingCliUpdate(store, "claude")).toBeNull();
    vi.unstubAllEnvs();
    await scheduler.stop();
  });
});
