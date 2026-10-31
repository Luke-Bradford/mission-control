/**
 * The write floors under a real seat's OS confinement (#737). The other floor tests read the
 * generated config; these launch the installed Codex and Claude CLIs through the same config and
 * settings the supervisor writes (`codexSeatConfig`, `crewSandboxSettings`), run a write probe
 * inside each and look at the disk. macOS only: Linux CI skips them, and the controller runs them
 * locally before merging any change to a floor (docs/runbook.md#Checking the write floors).
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CODEX_SEAT_PROFILE,
  CREW_CLI_ENV,
  CREW_GIT_ENV,
  CREW_ISOLATION_FLAGS,
  CREW_PNPM_ENV,
  type CrewMode,
  type CrewSandboxInput,
  crewPnpmStoreDir,
  crewSandboxSettings,
  crewSandboxTmp,
  MC_TMP_DIR_NAME,
  PNPM_STORE_ENV,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexPnpmStoreDir } from "../src/runtime/checkouts.ts";
import { CODEX_PROJECT_DIR, codexSeatConfig } from "../src/runtime/codex-floor.ts";
import { type FakeAnthropic, startFakeAnthropic } from "./fake-anthropic.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A CLI on PATH, or null. */
function installed(name: string): string | null {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** True when this process may apply a Seatbelt profile (a process already inside one may not). */
function seatbeltApplies(): boolean {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return false;
  try {
    execFileSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const canSandbox = seatbeltApplies();
const codexCli = canSandbox ? installed("codex") : null;
const claudeCli = canSandbox ? installed("claude") : null;

interface Layout {
  root: string;
  /** The seat's linked worktree, as the supervisor makes it. */
  cwd: string;
  gitCommonDir: string;
  worktreeGitDir: string;
  /** Stand-ins for the operator's home and the hub's data dir. */
  home: string;
  dataDir: string;
}

/** A clone with one commit and a linked worktree, every path real (the sandboxes match real paths). */
function makeLayout(): Layout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-floor-")));
  const clone = join(root, "clone");
  const cwd = join(root, "worktrees", "seat");
  const home = join(root, "operator");
  const dataDir = join(root, "data");
  for (const path of [clone, dirname(cwd), home, dataDir]) mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=floor", "-c", "user.email=floor@example.invalid", ...args],
      {
        cwd: clone,
        stdio: "ignore",
        env: { ...process.env, ...CREW_GIT_ENV, GIT_CONFIG_COUNT: "0" },
      },
    );
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "seat", cwd);
  return {
    root,
    cwd: realpathSync(cwd),
    gitCommonDir: realpathSync(join(clone, ".git")),
    worktreeGitDir: realpathSync(join(clone, ".git", "worktrees", "seat")),
    home,
    dataDir,
  };
}

/** What a probe aims at: a write that must land, or one the floor must refuse. */
interface Targets {
  allowed: string[];
  denied: string[];
}

/** An append per target, errors ignored: the disk, not an exit code, says what the floor did. */
const probeScript = (paths: string[]) =>
  `${paths.map((p) => `( printf x >> '${p}' ) 2>/dev/null`).join("; ")}; true`;

const snapshot = (paths: string[]) =>
  new Map(paths.map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]));

/** After the probe: every denied path is as it was (a created file would show), every allowed one written. */
function expectFloor(before: Map<string, string | null>, targets: Targets): void {
  for (const path of targets.denied) {
    expect(existsSync(path) ? readFileSync(path, "utf8") : null, `denied ${path}`).toBe(
      before.get(path),
    );
  }
  for (const path of targets.allowed) {
    expect(existsSync(path), `allowed ${path}`).toBe(true);
    expect(readFileSync(path, "utf8"), `allowed ${path}`).toContain("x");
  }
}

describe.skipIf(codexCli === null)("Codex seat floors under the real codex sandbox", () => {
  let l: Layout;
  beforeEach(() => {
    l = makeLayout();
  });
  afterEach(() => rmSync(l.root, { recursive: true, force: true }));

  it.each(["writer", "read-only"] as const)(
    "a %s seat's profile refuses the floor's paths and allows its own",
    (mode) => {
      const store = codexPnpmStoreDir(l.cwd);
      const input: CrewSandboxInput = { ...l, denyRead: [], pnpmStoreDir: store };
      const seatTmp = join(l.cwd, MC_TMP_DIR_NAME, "run");
      const codexHome = join(l.root, "codex-home");
      for (const path of [store, seatTmp, codexHome, join(l.cwd, CODEX_PROJECT_DIR)])
        mkdirSync(path, { recursive: true });
      writeFileSync(
        join(codexHome, "config.toml"),
        codexSeatConfig(input, mode, "http://127.0.0.1:1/mcp", seatTmp),
      );
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-fake" }));
      const targets: Targets = {
        allowed: [join(seatTmp, "ok.txt"), ...(mode === "writer" ? [join(l.cwd, "ok.txt")] : [])],
        denied: [
          join(store, "probe"),
          join(l.cwd, ".git"),
          join(l.gitCommonDir, "probe"),
          join(l.worktreeGitDir, "probe"),
          join(l.cwd, CODEX_PROJECT_DIR, "config.toml"),
          join(l.dataDir, "probe"),
          ...(mode === "writer" ? [] : [join(l.cwd, "ok.txt")]),
        ],
      };
      const before = snapshot([...targets.allowed, ...targets.denied]);
      execFileSync(
        codexCli as string,
        [
          "sandbox",
          "-C",
          l.cwd,
          "-P",
          CODEX_SEAT_PROFILE,
          "--",
          "/bin/sh",
          "-c",
          probeScript([...targets.allowed, ...targets.denied]),
        ],
        {
          cwd: l.cwd,
          env: {
            PATH: process.env.PATH,
            HOME: l.home,
            CODEX_HOME: codexHome,
            [PNPM_STORE_ENV]: store,
          },
          stdio: "ignore",
          timeout: 60_000,
        },
      );
      expectFloor(before, targets);
    },
    90_000,
  );
});

describe.skipIf(claudeCli === null)("Claude seat floors under the real claude sandbox", () => {
  let l: Layout;
  let tempRoot: string;
  let api: FakeAnthropic | null = null;

  beforeEach(() => {
    l = makeLayout();
    // The supervisor's own shape: a private folder under /tmp/claude-<uid>, which the settings deny reading as a whole.
    const parent = crewSandboxTmp(process.getuid?.() ?? 0);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    tempRoot = realpathSync(mkdtempSync(join(parent, "mc-floor-")));
  });
  afterEach(async () => {
    await api?.close();
    api = null;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(l.root, { recursive: true, force: true });
  });

  it.each(["writer", "read-only"] as const)(
    "a %s seat's settings refuse the floor's paths and allow its own",
    async (mode: Exclude<CrewMode, "scratch">) => {
      const input: CrewSandboxInput = {
        ...l,
        tempRoot,
        denyRead: [],
        pnpmStoreDir: join(l.root, ".mc-pnpm-store", "shared"),
      };
      const store = crewPnpmStoreDir(tempRoot, "seat");
      mkdirSync(store, { recursive: true });
      const targets: Targets = {
        // a Claude seat's pnpm store is its own, in its temp root: writable, and nowhere else
        allowed: [
          join(tempRoot, "ok.txt"),
          join(store, "ok.txt"),
          ...(mode === "writer" ? [join(l.cwd, "ok.txt")] : []),
        ],
        denied: [
          join(l.cwd, ".git"),
          join(l.gitCommonDir, "probe"),
          join(l.worktreeGitDir, "probe"),
          join(l.dataDir, "probe"),
          ...(mode === "writer" ? [] : [join(l.cwd, "ok.txt")]),
        ],
      };
      const before = snapshot([...targets.allowed, ...targets.denied]);
      // the store write goes through the env var the supervisor sets, so a missing or different
      // binding leaves store/ok.txt unwritten and fails the allowed check
      const storeTarget = join(store, "ok.txt");
      const probed = [...targets.allowed, ...targets.denied].filter((p) => p !== storeTarget);
      api = await startFakeAnthropic(
        `${probeScript(probed)}; ( printf x >> "$${PNPM_STORE_ENV}/ok.txt" ) 2>/dev/null; true`,
      );
      const settings = crewSandboxSettings(input, mode, { command: "/usr/bin/true", timeoutS: 5 });
      const claude = spawn(
        claudeCli as string,
        [
          "-p",
          "run the probe",
          "--output-format",
          "json",
          "--model",
          "claude-fake",
          ...CREW_ISOLATION_FLAGS,
          "--tools",
          "Bash",
          "--settings",
          settings,
          "--allowedTools",
          "Bash",
        ],
        {
          cwd: l.cwd,
          env: {
            PATH: process.env.PATH,
            HOME: l.home,
            TMPDIR: tempRoot,
            CLAUDE_CODE_TMPDIR: tempRoot,
            [PNPM_STORE_ENV]: store,
            ANTHROPIC_BASE_URL: api.url,
            ANTHROPIC_API_KEY: "sk-ant-fake",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            ...CREW_CLI_ENV,
            ...CREW_PNPM_ENV,
            ...CREW_GIT_ENV,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      claude.stdout.on("data", (c) => {
        output += c;
      });
      claude.stderr.on("data", (c) => {
        output += c;
      });
      const timer = setTimeout(() => claude.kill(), 90_000);
      await new Promise((resolve) => claude.on("close", resolve));
      clearTimeout(timer);
      // the probe ran: the CLI reached the model and the allowed writes landed
      expect(api.bashCalls(), output).toBe(1);
      expectFloor(before, targets);
    },
    120_000,
  );
});

/** A hub stand-in on loopback: counts every request a probe makes to it. */
async function listenOnLoopback(): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.end("token");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port, hits: () => hits };
}

/**
 * The hub port the probes aim at: a hub answering on 7420 when there is one (a developer's sandboxed
 * shell may allow only that port), else the test's own stand-in on loopback.
 */
async function hubTarget(): Promise<{
  port: number;
  close: () => void;
  hits: () => number | null;
}> {
  try {
    execFileSync("/usr/bin/curl", ["-s", "-m", "2", "-o", "/dev/null", "http://127.0.0.1:7420/"], {
      stdio: "ignore",
    });
    return { port: 7420, close: () => {}, hits: () => null };
  } catch {
    const own = await listenOnLoopback();
    return { port: own.port, close: () => own.server.close(), hits: own.hits };
  }
}

/** curl the hub; a reached hub leaves its HTTP code in `marker`. */
const loopbackProbe = (port: number, marker: string) =>
  `( /usr/bin/curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/api/operator/bootstrap -H 'sec-fetch-site: same-origin' >> '${marker}' ) 2>/dev/null; true`;

describe("the loopback probe itself", () => {
  it("reaches the hub when run outside any sandbox", async () => {
    const hub = await hubTarget();
    const dir = mkdtempSync(join(tmpdir(), "mc-loop-ctl-"));
    const marker = join(dir, "reached.txt");
    try {
      execFileSync("/bin/sh", ["-c", loopbackProbe(hub.port, marker)], {
        stdio: "ignore",
        timeout: 20_000,
      });
    } finally {
      hub.close();
    }
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "", "the hub's HTTP code").toMatch(
      /^\d{3}$/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

// A Codex seat's network is off in its live sandbox state (thread/start reports `networkAccess:false`,
// and `curl http://127.0.0.1:7420/` fails with exit 7: docs/spikes/2026-10-24-codex-seat-confinement.md).
// `codex sandbox -P` applies the profile's filesystem rules but not that network state, so the
// probe is not repeated here.

describe.skipIf(claudeCli === null)("a Claude seat cannot reach the hub on loopback (#956)", () => {
  let l: Layout;
  let tempRoot: string;
  let api: FakeAnthropic | null = null;
  beforeEach(() => {
    l = makeLayout();
    const parent = crewSandboxTmp(process.getuid?.() ?? 0);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    tempRoot = realpathSync(mkdtempSync(join(parent, "mc-loop-")));
  });
  afterEach(async () => {
    await api?.close();
    api = null;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(l.root, { recursive: true, force: true });
  });
  it.each(["writer", "read-only"] as const)(
    "a %s seat's curl to 127.0.0.1 gets nothing",
    async (mode: Exclude<CrewMode, "scratch">) => {
      const input: CrewSandboxInput = {
        ...l,
        tempRoot,
        denyRead: [],
        pnpmStoreDir: join(l.root, ".mc-pnpm-store", "shared"),
      };
      const store = crewPnpmStoreDir(tempRoot, "seat");
      mkdirSync(store, { recursive: true });
      const hub = await hubTarget();
      const marker = join(tempRoot, "reached.txt");
      api = await startFakeAnthropic(loopbackProbe(hub.port, marker));
      const settings = crewSandboxSettings(input, mode, { command: "/usr/bin/true", timeoutS: 5 });
      const claude = spawn(
        claudeCli as string,
        [
          "-p",
          "run the probe",
          "--output-format",
          "json",
          "--model",
          "claude-fake",
          ...CREW_ISOLATION_FLAGS,
          "--tools",
          "Bash",
          "--settings",
          settings,
          "--allowedTools",
          "Bash",
        ],
        {
          cwd: l.cwd,
          env: {
            PATH: process.env.PATH,
            HOME: l.home,
            TMPDIR: tempRoot,
            CLAUDE_CODE_TMPDIR: tempRoot,
            [PNPM_STORE_ENV]: store,
            ANTHROPIC_BASE_URL: api.url,
            ANTHROPIC_API_KEY: "sk-ant-fake",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        },
      );
      let output = "";
      claude.stdout.on("data", (c) => {
        output += c;
      });
      claude.stderr.on("data", (c) => {
        output += c;
      });
      const timer = setTimeout(() => claude.kill(), 90_000);
      await new Promise((resolve) => claude.on("close", resolve));
      clearTimeout(timer);
      hub.close();
      // the probe ran (the CLI itself reached the model API), and the Bash curl got nothing
      expect(api.bashCalls(), output).toBe(1);
      expect(hub.hits() ?? 0, "requests that reached the hub").toBe(0);
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "", "the probe's marker").toBe("");
    },
    120_000,
  );
});
