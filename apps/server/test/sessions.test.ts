import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultIsAlive,
  isSameProcessAlive,
  type LiveSession,
  makeProcessStart,
  PS_ENV,
  readSessions,
  sessionForLoop,
} from "../src/collectors/sessions.ts";
import type { AdoptedLoop } from "../src/config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-sessions-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: unknown) => {
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
};

const entry = (over: Record<string, unknown> = {}) => ({
  pid: 100,
  sessionId: "s-100",
  cwd: "/work/loop",
  startedAt: 1_000,
  status: "busy",
  name: "loop-1",
  version: "2.1.302",
  entrypoint: "sdk-cli",
  messagingSocketPath: "/tmp/cc-socks/100.sock",
  ...over,
});

const loop = (over: Partial<AdoptedLoop> = {}): AdoptedLoop => ({
  id: "a1" as AdoptedLoop["id"],
  repoId: "repo" as AdoptedLoop["repoId"],
  kind: "ta-loop",
  accountId: "acc" as AdoptedLoop["accountId"],
  stateDir: "/state",
  worktree: "/work/loop",
  launchdLabel: "label",
  ...over,
});

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  pid: 1,
  sessionId: "s",
  cwd: "/work/loop",
  startedAt: 0,
  status: "idle",
  name: "n",
  alive: true,
  ...over,
});

describe("readSessions", () => {
  it("maps the real registry shape to LiveSession and marks liveness via isAlive", () => {
    write("100.json", entry({ pid: 100, startedAt: 1_792_232_403_924 }));
    write("200.json", entry({ pid: 200, sessionId: "s-200", status: null }));
    const alive = new Set([100]);

    const sessions = readSessions(dir, (pid) => alive.has(pid));

    expect(sessions.sort((a, b) => a.pid - b.pid)).toEqual([
      {
        pid: 100,
        sessionId: "s-100",
        cwd: "/work/loop",
        startedAt: 1_792_232_403_924,
        status: "busy",
        name: "loop-1",
        alive: true,
      },
      {
        pid: 200,
        sessionId: "s-200",
        cwd: "/work/loop",
        startedAt: 1_000,
        status: null,
        name: "loop-1",
        alive: false,
      },
    ]);
  });

  it("skips malformed files without throwing and ignores non-json files", () => {
    write("100.json", entry({ pid: 100 }));
    write("bad.json", "{not json");
    write("notes.txt", entry({ pid: 999 }));
    write("300.json", { pid: "nope" });

    const sessions = readSessions(dir, () => true);

    expect(sessions.map((s) => s.pid)).toEqual([100]);
  });

  it("returns [] when the directory is missing", () => {
    expect(readSessions(join(dir, "absent"), () => true)).toEqual([]);
  });

  it("ignores subdirectories named *.json", () => {
    mkdirSync(join(dir, "dir.json"));
    write("100.json", entry({ pid: 100 }));
    expect(readSessions(dir, () => true).map((s) => s.pid)).toEqual([100]);
  });

  it.each([
    ["a missing cwd", { cwd: undefined }],
    ["a numeric sessionId", { sessionId: 42 }],
    ["pid 0", { pid: 0 }],
    ["a negative pid", { pid: -1 }],
    ["a non-integer pid", { pid: 1.5 }],
    ["a negative startedAt", { startedAt: -1 }],
  ])("skips an entry with %s", (_label, over) => {
    write("entry.json", entry({ pid: 100, ...over }));
    write("ok.json", entry({ pid: 200 }));
    expect(readSessions(dir, () => true).map((s) => s.pid)).toEqual([200]);
  });
});

describe("sessionForLoop", () => {
  it("matches the loop by cwd against loop.worktree", () => {
    const sessions = [
      session({ pid: 1, cwd: "/work/other" }),
      session({ pid: 2, cwd: "/work/loop" }),
    ];
    expect(sessionForLoop(sessions, loop())?.pid).toBe(2);
  });

  it("compares paths after path.resolve, so trailing slashes and ./segments match", () => {
    const sessions = [session({ pid: 3, cwd: "/work/loop/" })];
    expect(sessionForLoop(sessions, loop({ worktree: "/work/./loop" }))?.pid).toBe(3);
  });

  it("ignores dead sessions even when they are the only match", () => {
    const sessions = [session({ pid: 4, alive: false })];
    expect(sessionForLoop(sessions, loop())).toBeNull();
  });

  it("picks the alive match with the newest startedAt", () => {
    const sessions = [
      session({ pid: 5, startedAt: 100 }),
      session({ pid: 6, startedAt: 300 }),
      session({ pid: 7, startedAt: 200 }),
      session({ pid: 8, startedAt: 900, alive: false }),
    ];
    expect(sessionForLoop(sessions, loop())?.pid).toBe(6);
  });

  it("returns null when nothing matches", () => {
    expect(sessionForLoop([session({ cwd: "/elsewhere" })], loop())).toBeNull();
    expect(sessionForLoop([], loop())).toBeNull();
  });
});

describe("defaultIsAlive", () => {
  it("is true for the current process", () => {
    expect(defaultIsAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that does not exist", () => {
    // Far above any real pid maximum, so the kernel returns ESRCH.
    expect(defaultIsAlive(2_147_483_646)).toBe(false);
  });

  it.each([0, -1, Number.NaN, 1.5])(
    "is false without signalling for non-positive or invalid pid %s",
    (pid) => {
      const kill = vi.spyOn(process, "kill");
      try {
        expect(defaultIsAlive(pid)).toBe(false);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    },
  );
});

describe("makeProcessStart", () => {
  type Exec = Parameters<typeof makeProcessStart>[0];
  const failing = (status: number, stderr: string) =>
    (() => {
      throw Object.assign(new Error("ps failed"), { status, stderr });
    }) as unknown as Exec;

  it("runs ps with the timezone and locale pinned, for the pid given", () => {
    const calls: { cmd: unknown; args: unknown; opts: { env?: Record<string, string> } }[] = [];
    const exec = ((cmd: unknown, args: unknown, opts: { env?: Record<string, string> }) => {
      calls.push({ cmd, args, opts });
      return "Tue Oct 20 09:00:00 2026\n";
    }) as unknown as Exec;
    expect(makeProcessStart(exec)(41)).toBe("Tue Oct 20 09:00:00 2026");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("ps");
    expect(calls[0]?.args).toEqual(["-o", "lstart=", "-p", "41"]);
    expect(calls[0]?.opts.env).toMatchObject(PS_ENV);
    expect(PS_ENV).toEqual({ TZ: "UTC", LC_ALL: "C" });
  });

  it("reads exit 1 with an empty stderr as no such process", () => {
    expect(makeProcessStart(failing(1, ""))(41)).toBeNull();
  });

  it("throws on exit 1 with anything on stderr (a failed ps, not a missing process)", () => {
    expect(() => makeProcessStart(failing(1, "ps: illegal option"))(41)).toThrow();
  });

  it("falls back to signal 0 when ps failed with stderr", () => {
    const start = makeProcessStart(failing(1, "ps: Operation not permitted"));
    expect(isSameProcessAlive(new Map(), process.pid, start)).toBe(true);
  });
});

describe("isSameProcessAlive", () => {
  const START = "Tue Oct 20 09:00:00 2026";
  const REUSED = "Wed Oct 21 01:00:00 2026";

  it("is alive for the same pid with the same start time", () => {
    const starts = new Map<number, string>();
    expect(isSameProcessAlive(starts, 7522, () => START)).toBe(true);
    expect(starts.get(7522)).toBe(START);
    expect(isSameProcessAlive(starts, 7522, () => START)).toBe(true);
  });

  it("is dead for the same pid with a different start time (a reused pid)", () => {
    const starts = new Map<number, string>();
    isSameProcessAlive(starts, 7522, () => START);
    expect(isSameProcessAlive(starts, 7522, () => REUSED)).toBe(false);
    // The recorded start is kept, so the reused pid stays dead on the next read.
    expect(isSameProcessAlive(starts, 7522, () => REUSED)).toBe(false);
  });

  it("is dead when there is no process", () => {
    const starts = new Map<number, string>([[7522, START]]);
    expect(isSameProcessAlive(starts, 7522, () => null)).toBe(false);
    expect(starts.has(7522)).toBe(false);
  });

  it("asks ps about the pid it was given", () => {
    const asked: number[] = [];
    isSameProcessAlive(new Map(), 41, (pid) => {
      asked.push(pid);
      return START;
    });
    expect(asked).toEqual([41]);
  });

  it("falls back to signal 0 when ps cannot run", () => {
    const broken = () => {
      throw new Error("spawn ps ENOENT");
    };
    expect(isSameProcessAlive(new Map(), process.pid, broken)).toBe(true);
    expect(isSameProcessAlive(new Map(), 2_147_483_646, broken)).toBe(false);
  });
});
