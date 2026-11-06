import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import {
  autoUpdateCli,
  type CliToolOps,
  cliUpdateKind,
  heldCliVersion,
  realCliOps,
} from "../src/cli-auto.ts";
import { CliHold, type ExecFn } from "../src/cli-update.ts";
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

  it("leaves a hold set by someone else alone and installs nothing", async () => {
    const { state, ops } = fakeOps("2.1.0", "2.2.0");
    hold.hold("claude CLI is upgrading");
    expect(await run("claude", ops)).toBe("busy");
    expect(state.installs).toEqual([]);
    expect(hold.reason).toBe("claude CLI is upgrading");
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
    const { exec, calls } = record((file) => (file === "npm" ? "2.3.4\n" : "codex-cli 0.5.6\n"));
    expect(await realCliOps("claude", exec).latest()).toBe("2.3.4");
    expect(calls[0]).toMatchObject({
      file: "npm",
      args: ["view", "@anthropic-ai/claude-code", "version"],
    });
    expect(await realCliOps("codex", exec).installed()).toBe("0.5.6");
  });

  it("installs one exact version with no shell, and refuses a version that is not x.y.z", async () => {
    const { exec, calls } = record();
    expect(await realCliOps("codex", exec).install("0.5.7")).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ file: "npm", args: ["install", "-g", "@openai/codex@0.5.7"] });
    expect((await realCliOps("codex", exec).install("0.5.7 --foo")).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("passes the live check only when the version matches and a tool call returned the nonce", async () => {
    let prompt = "";
    const ok = record((file, args) => {
      if (args[0] === "--version") return "2.3.4 (Claude Code)\n";
      prompt = args.at(-1) ?? "";
      const dirIn = /check-[a-f0-9]+\.txt/.exec(prompt)?.[0];
      return dirIn === undefined ? "?" : `NONCE:${dirIn}`;
    });
    // the fake cannot read the file, so the check must fail: a version print alone is not enough
    const r = await realCliOps("claude", ok.exec).check("2.3.4");
    expect(r.ok).toBe(false);
    expect(ok.calls.map((c) => c.file)).toEqual(["claude", "claude"]);
    expect(ok.calls[1].args).toEqual(expect.arrayContaining(["-p", "--allowedTools", "Read"]));
    expect(ok.calls[1].cwd).toBeDefined();
    const wrongVersion = record(() => "9.9.9 (Claude Code)\n");
    expect((await realCliOps("claude", wrongVersion.exec).check("2.3.4")).ok).toBe(false);
    expect(wrongVersion.calls).toHaveLength(1);
  });

  it("passes when the answer holds the nonce the harness wrote", async () => {
    const { exec, calls } = record((_f, args) => {
      if (args[0] === "--version") return "codex-cli 0.5.6\n";
      return "token ".concat(
        // echo back whatever nonce file the harness wrote, as a tool call would
        readFileSync(
          join(calls.at(-1)?.cwd ?? "", /check-[a-f0-9]+\.txt/.exec(args.at(-1) ?? "")?.[0] ?? ""),
          "utf8",
        ),
      );
    });
    const r = await realCliOps("codex", exec).check("0.5.6");
    expect(r.ok).toBe(true);
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
