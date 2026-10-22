import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import {
  CLI_COLLECTOR,
  CLI_NOTE_KEY,
  CliHold,
  checkCli,
  cliFailedText,
  NOT_A_CASK,
  realExec,
} from "../src/cli-update.ts";
import type { CcConfig } from "../src/config.ts";
import { type Collectors, createScheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

let dir: string;
let bin: string;
let store: Store;
let hold: CliHold;

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A fake cask version: `claude --version` and `claude -p` as the version at `at` would answer. */
function installVersion(version: string): string {
  const folder = join(dir, "Caskroom", "claude-code", version);
  mkdirSync(folder, { recursive: true });
  const claude = join(folder, "claude");
  script(
    claude,
    `case "$1" in
  --version) echo "${version} (Claude Code)" ;;
  -p)
    if [ -f "${bin}/smoke-fail-${version}" ]; then echo "boom: ${version} cannot start" >&2; echo "second line" >&2; exit 1; fi
    echo OK ;;
esac`,
  );
  return claude;
}

const point = (target: string) => {
  rmSync(join(bin, "claude"), { force: true });
  symlinkSync(target, join(bin, "claude"));
};

/** A fake `brew`: `outdated` lists the cask while `<bin>/outdated` exists; `upgrade` moves the link to 2.0.0. */
function fakeBrew(opts: { upgradeFails?: boolean } = {}) {
  const log = join(dir, "brew.log");
  script(
    join(bin, "brew"),
    `echo "$@" >> "${log}"
case "$1" in
  outdated)
    if [ -f "${bin}/outdated" ]; then echo '{"formulae":[],"casks":[{"name":"claude-code","installed_versions":["1.0.0"],"current_version":"2.0.0"}]}';
    else echo '{"formulae":[],"casks":[]}'; fi ;;
  upgrade)
    ${opts.upgradeFails ? 'echo "Error: download failed" >&2; exit 1' : `ln -sfn "${join(dir, "Caskroom", "claude-code", "2.0.0", "claude")}" "${join(bin, "claude")}"; rm -f "${bin}/outdated"`} ;;
esac`,
  );
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

const env = () => ({ PATH: `${bin}:/usr/bin:/bin` });
const run = () => checkCli({ exec: realExec, env: env() });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-cli-update-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  installVersion("1.0.0");
  installVersion("2.0.0");
  point(join(dir, "Caskroom", "claude-code", "1.0.0", "claude"));
  store = new Store(join(dir, "mc.sqlite"));
  hold = new CliHold();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkCli", () => {
  it("upgrades an outdated cask and smoke-tests the new version", async () => {
    const brew = fakeBrew();
    writeFileSync(join(bin, "outdated"), "");
    expect(await run()).toEqual({
      cask: true,
      version: "2.0.0",
      upgraded: true,
      brewProblem: null,
      smokeFailure: null,
    });
    expect(brew()).toEqual([
      "outdated --cask --greedy --json=v2 claude-code",
      "upgrade --cask claude-code",
    ]);
  });

  it("does not upgrade a current cask, and still smoke-tests it", async () => {
    const brew = fakeBrew();
    expect(await run()).toMatchObject({ cask: true, version: "1.0.0", upgraded: false });
    expect(brew()).toEqual(["outdated --cask --greedy --json=v2 claude-code"]);
  });

  it("reports the first line of a failing smoke test", async () => {
    fakeBrew();
    writeFileSync(join(bin, "smoke-fail-1.0.0"), "");
    expect(await run()).toMatchObject({
      cask: true,
      version: "1.0.0",
      smokeFailure: "boom: 1.0.0 cannot start",
    });
  });

  it("keeps the old version when the upgrade fails, and says so", async () => {
    fakeBrew({ upgradeFails: true });
    writeFileSync(join(bin, "outdated"), "");
    expect(await run()).toMatchObject({
      version: "1.0.0",
      upgraded: false,
      brewProblem: "brew upgrade failed: Error: download failed",
      smokeFailure: null,
    });
  });

  it("changes nothing when claude is not the Homebrew cask", async () => {
    const brew = fakeBrew();
    const elsewhere = join(dir, "npm", "claude");
    mkdirSync(join(dir, "npm"));
    script(elsewhere, 'echo "3.0.0"');
    point(elsewhere);
    expect(await run()).toEqual({ cask: false, found: true });
    expect(brew()).toEqual([]);
  });
});

describe("the cli job", () => {
  const config = (cli: "off" | "between_runs"): CcConfig => ({
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    updates: { cli },
  });
  const make = (cli: "off" | "between_runs", over: Partial<Collectors> = {}) => {
    const topics: string[] = [];
    const bus = new ChangeBus();
    bus.subscribe((t) => topics.push(t));
    const scheduler = createScheduler({
      config: config(cli),
      store,
      bus,
      cliHold: hold,
      collectors: { cli: () => checkCli({ exec: realExec, env: env() }), ...over },
    });
    return { scheduler, topics };
  };
  const row = () => store.status().find((s) => s.collector === CLI_COLLECTOR);
  const note = () => store.notes().find((n) => n.key === CLI_NOTE_KEY);

  it("upgrades, records the new version on the health row and holds nothing", async () => {
    const brew = fakeBrew();
    writeFileSync(join(bin, "outdated"), "");
    const { scheduler } = make("between_runs");
    expect(await scheduler.tick("cli")).toBe("ran");
    expect(row()).toMatchObject({ ok: true, error: "claude 2.0.0, upgraded" });
    expect(hold.reason).toBeNull();
    expect(note()).toBeUndefined();
    expect(brew()).toHaveLength(2);
    await scheduler.stop();
  });

  it("holds new starts and raises one note when the smoke test fails, until a later check passes", async () => {
    fakeBrew();
    writeFileSync(join(bin, "smoke-fail-1.0.0"), "");
    const released: number[] = [];
    hold.onRelease(() => released.push(1));
    const { scheduler } = make("between_runs");
    await scheduler.tick("cli");
    await scheduler.tick("cli");
    expect(hold.reason).toBe(cliFailedText("1.0.0", "boom: 1.0.0 cannot start"));
    expect(store.notes().filter((n) => n.key === CLI_NOTE_KEY)).toHaveLength(1);
    expect(note()?.text).toBe(
      "claude CLI 1.0.0 failed its smoke test: boom: 1.0.0 cannot start; no new runs start until it passes",
    );
    expect(note()?.kind).toBe("blocked");
    expect(row()).toMatchObject({ ok: false });

    rmSync(join(bin, "smoke-fail-1.0.0"));
    await scheduler.tick("cli");
    expect(hold.reason).toBeNull();
    expect(note()).toBeUndefined();
    expect(row()).toMatchObject({ ok: true, error: "claude 1.0.0" });
    expect(released).toEqual([1]);
    await scheduler.stop();
  });

  it("runs nothing when updates.cli is off", async () => {
    const brew = fakeBrew();
    writeFileSync(join(bin, "outdated"), "");
    writeFileSync(join(bin, "smoke-fail-1.0.0"), "");
    const { scheduler } = make("off");
    expect(await scheduler.tick("cli")).toBe("ran");
    expect(brew()).toEqual([]);
    expect(row()).toBeUndefined();
    expect(hold.reason).toBeNull();
    await scheduler.stop();
  });

  it("sets the row and changes nothing when claude is not a Homebrew cask", async () => {
    const brew = fakeBrew();
    const elsewhere = join(dir, "npm", "claude");
    mkdirSync(join(dir, "npm"));
    script(elsewhere, 'echo "3.0.0"');
    point(elsewhere);
    const { scheduler } = make("between_runs");
    await scheduler.tick("cli");
    expect(row()).toMatchObject({ ok: false, error: NOT_A_CASK });
    expect(brew()).toEqual([]);
    expect(hold.reason).toBeNull();
    await scheduler.stop();
  });
});
