import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endKeeper,
  HUB_ABSENT_TEXT,
  KEEPER_EXIT_FILE,
  KEEPER_PROTOCOL_VERSION,
  KEEPER_SOCKET,
  KEEPER_SPEC_FILE,
  type KeeperSpec,
  NO_SECRET_TEXT,
  parsePsLine,
  readKeeperExit,
  readPidFile,
  runKeeper,
} from "../src/runtime/keeper.ts";

let dir: string;
let transcript: string;
let folders = 0;
const running: Promise<void>[] = [];
const SECRET = "ab".repeat(32);
const CLI_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-keeper-")));
  transcript = join(dir, "seat.jsonl");
  folders = 0;
});
afterEach(async () => {
  // whatever a test left running: no CLI outlives it, a failed test included
  for (let n = 1; n <= folders; n++) await endKeeper(join(dir, `k${n}`), 100);
  await Promise.all(running.splice(0));
  rmSync(dir, { recursive: true, force: true });
});

const until = (fn: () => unknown) => vi.waitFor(fn, { timeout: 5000, interval: 10 });
const lines = () => readFileSync(transcript, "utf8").split("\n").slice(0, -1);

/** A run folder whose CLI is `node -e <script>`. */
function folderFor(script: string, over: Partial<KeeperSpec> = {}): string {
  const folder = join(dir, `k${++folders}`);
  mkdirSync(folder, { mode: 0o700 });
  const spec: KeeperSpec = {
    runId: "run",
    spawn: "spawn-1",
    command: process.execPath,
    // the session id is a trailing argument: the CLI's command line carries it, as the real one does
    args: ["-e", script, CLI_ID],
    secret: SECRET,
    cliSessionId: CLI_ID,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    transcriptPath: transcript,
    stdoutLineMax: 64 * 1024 * 1024,
    stderrLineMax: 64 * 1024,
    stopGraceMs: 300,
    // most tests have their hub connect before the CLI ends; the ones with none need not wait for it
    firstHubWaitMs: 0,
    ...over,
  };
  writeFileSync(join(folder, KEEPER_SPEC_FILE), JSON.stringify(spec), { mode: 0o600 });
  return folder;
}

/** Runs the keeper in this process; its `done` is waited for after the test. */
function keep(folder: string, opts?: Parameters<typeof runKeeper>[1]) {
  const k = runKeeper(folder, opts);
  running.push(k.done);
  return k;
}

type Msg = Record<string, unknown>;

/** A hub's end of the socket: every line the keeper sends, parsed, and a way to say things. */
async function client(folder: string) {
  await until(() => expect(existsSync(join(folder, KEEPER_SOCKET))).toBe(true));
  const sock = connect(join(folder, KEEPER_SOCKET));
  const msgs: Msg[] = [];
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      msgs.push(JSON.parse(buf.slice(0, nl)) as Msg);
      buf = buf.slice(nl + 1);
    }
  });
  sock.on("error", () => {});
  const closed = new Promise<void>((r) => sock.on("close", () => r()));
  // a hello carries the spec's secret unless the test gives its own
  const say = (m: Msg) =>
    sock.write(
      `${JSON.stringify(m.t === "hello" && !("secret" in m) ? { ...m, secret: SECRET } : m)}\n`,
    );
  const outs = () => msgs.filter((m) => m.t === "out").map((m) => [m.n, m.line]);
  await until(() => expect(msgs[0]?.t).toBe("hello"));
  return { sock, msgs, closed, say, outs };
}

describe("the keeper's transcript writer", () => {
  it("writes the whole line when the writer writes short", async () => {
    const chunks: Buffer[] = [];
    const k = keep(folderFor(`console.log("hello world")`), {
      write: (fd, data) => {
        const part = data.subarray(0, 3);
        chunks.push(Buffer.from(part));
        return writeSync(fd, part);
      },
    });
    await k.done;
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks).toString()).toBe("hello world\n");
    expect(lines()).toEqual(["hello world"]);
  });

  it("a writer that writes no bytes is reported once, and the run still exits", async () => {
    // Without the guard record() would spin on 0 forever; the throw turns that into a failure.
    let calls = 0;
    const folder = folderFor(
      `setTimeout(() => { console.log("a"); console.log("b"); }, 400); process.stdin.resume();
       process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder, {
      write: () => {
        if (++calls > 1000) throw new Error("spun");
        return 0;
      },
    });
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(c.outs()).toHaveLength(2));
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    await c.closed; // the exit line is on its way when the keeper is done
    expect(c.msgs.filter((m) => m.t === "err")).toEqual([
      { t: "err", text: "transcript write failed: no bytes written" },
    ]);
    // the lines the file could not take are still numbered and sent, from memory
    expect(c.outs()).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    expect(c.msgs.at(-1)).toEqual({ t: "exit", code: 0, signal: null });
  });

  it("reports a failing writer once", async () => {
    const folder = folderFor(
      `console.log("a"); setTimeout(() => console.log("b"), 100);
       process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder, {
      write: () => {
        throw new Error("disk full");
      },
    });
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(c.outs()).toHaveLength(2));
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    expect(c.msgs.filter((m) => m.t === "err")).toEqual([
      { t: "err", text: "transcript write failed: disk full" },
    ]);
  });
});

describe("the keeper", () => {
  it("says hello first, with its version, spawn id and the line count", async () => {
    const folder = folderFor(
      `process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder);
    const c = await client(folder);
    expect(c.msgs[0]).toEqual({
      t: "hello",
      version: KEEPER_PROTOCOL_VERSION,
      spawn: "spawn-1",
      pid: process.pid,
      cliPid: expect.any(Number),
      lines: 0,
      awaiting: false,
    });
    expect(readPidFile(folder, "keeper.pid")).toBe(process.pid);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "close", graceMs: 300 });
    await k.done;
  });

  it("replays from the asked line, then live lines, and a new client replaces the old", async () => {
    const folder = folderFor(
      `const out = (s) => process.stdout.write(s + "\\n");
       out("l0"); out("l1"); out("l2");
       setTimeout(() => out("l3"), 300);
       setTimeout(() => out("l4"), 700);
       process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));`,
    );
    const k = keep(folder);
    const a = await client(folder);
    a.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(a.outs()).toHaveLength(4));
    expect(a.outs()).toEqual([
      [0, "l0"],
      [1, "l1"],
      [2, "l2"],
      [3, "l3"],
    ]);
    // a second hub connects: the first one is let go, and the second is read from line 2
    const b = await client(folder);
    expect(b.msgs[0]).toMatchObject({ t: "hello", lines: expect.any(Number) });
    b.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 2 });
    await a.closed;
    await until(() => expect(b.outs()).toHaveLength(3));
    expect(b.outs()).toEqual([
      [2, "l2"],
      [3, "l3"],
      [4, "l4"],
    ]);
    // a line number past the end is clamped to it: nothing to replay, then the exit
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 99 });
    await b.closed;
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    await c.closed;
    expect(c.outs()).toEqual([]);
    expect(c.msgs.at(-1)).toEqual({ t: "exit", code: 0, signal: null });
    expect(lines()).toEqual(["l0", "l1", "l2", "l3", "l4"]);
    expect(readKeeperExit(folder)).toMatchObject({ code: 0, signal: null });
  });

  it("sends a hub that was away every line it asks for, in order, before the exit", async () => {
    // more lines than one replay batch (500), written while no hub is attached
    const folder = folderFor(
      `let s = ""; for (let i = 0; i < 1200; i++) s += "line" + i + "\\n"; process.stdout.write(s);
       process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder);
    await until(() => expect(lines()).toHaveLength(1200));
    const c = await client(folder);
    expect(c.msgs[0]).toMatchObject({ lines: 1200 });
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 100 });
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    await c.closed;
    const outs = c.outs();
    expect(outs).toHaveLength(1100);
    expect(outs[0]).toEqual([100, "line100"]);
    expect(outs.at(-1)).toEqual([1199, "line1199"]);
    // every number once, in order, and the exit after the last of them
    expect(outs.map((o) => o[0])).toEqual(Array.from({ length: 1100 }, (_, i) => 100 + i));
    expect(c.msgs.at(-1)?.t).toBe("exit");
  });

  it("writes a user line to the CLI's stdin and tracks the turn that is awaited", async () => {
    const folder = folderFor(
      `require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
         console.log(JSON.stringify({ echo: l }));
         console.log(JSON.stringify({ type: "result" }));
       });`,
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "hi", user: true });
    await until(() => expect(c.outs()).toHaveLength(2));
    expect(c.outs()).toEqual([
      [0, '{"echo":"hi"}'],
      [1, '{"type":"result"}'],
    ]);
    // a new client sees the turn as over: its result has come
    const d = await client(folder);
    expect(d.msgs[0]).toMatchObject({ lines: 2, awaiting: false });
    d.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 2 });
    d.say({ t: "close", graceMs: 300 });
    await k.done;
  });

  it("says awaiting while a user line's result has not come", async () => {
    const folder = folderFor(
      `process.stdin.resume(); process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder);
    const a = await client(folder);
    a.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    a.say({ t: "in", line: "go", user: true });
    await until(async () => {
      const b = await client(folder);
      expect(b.msgs[0]).toMatchObject({ awaiting: true });
      b.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
      b.say({ t: "close", graceMs: 300 });
    });
    await k.done;
  });

  it("records the exit in exit.json before it ends, with the last stderr line", async () => {
    const folder = folderFor(
      `console.error("first"); console.error("last words"); process.exit(3);`,
    );
    const k = keep(folder);
    await k.done;
    expect(readKeeperExit(folder)).toEqual({
      code: 3,
      signal: null,
      at: expect.any(Number),
      lastStderr: "last words",
    });
    expect(existsSync(join(folder, KEEPER_SOCKET))).toBe(false);
  });

  it("a CLI that ends before the first hub comes waits for it: the hub gets its lines, stderr and exit", async () => {
    const folder = folderFor(`console.log("only line"); console.error("oops"); process.exit(2);`, {
      firstHubWaitMs: 5000,
    });
    const k = keep(folder);
    await until(() => expect(existsSync(join(folder, KEEPER_EXIT_FILE))).toBe(true));
    const c = await client(folder);
    expect(c.msgs[0]).toMatchObject({ t: "hello", lines: 1 });
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await k.done;
    await c.closed;
    expect(c.outs()).toEqual([[0, "only line"]]);
    expect(c.msgs.filter((m) => m.t === "err")).toEqual([{ t: "err", text: "oops" }]);
    expect(c.msgs.at(-1)).toEqual({ t: "exit", code: 2, signal: null });
  });

  it("a CLI that cannot start leaves an exit file saying so", async () => {
    const folder = folderFor("", { command: join(dir, "no-such-claude"), args: [] });
    const k = keep(folder);
    await k.done;
    const exit = readKeeperExit(folder);
    expect(exit).toMatchObject({ code: null, signal: null });
    expect(exit?.lastStderr).toMatch(/^could not start the CLI: /);
  });

  it("terminate() ends the CLI with SIGTERM, and SIGKILL when it will not go", async () => {
    const folder = folderFor(
      `process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000);`,
    );
    const k = keep(folder);
    // its SIGTERM handler is in place once it has said so
    await until(() => expect(lines()).toEqual(["up"]));
    const t0 = Date.now();
    k.terminate();
    await k.done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(readKeeperExit(folder)).toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("a keeper folder's files are private", async () => {
    const folder = folderFor(
      `process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder);
    const c = await client(folder);
    for (const f of ["cli.pid", "keeper.pid", KEEPER_SOCKET]) {
      expect(statSync(join(folder, f)).mode & 0o077).toBe(0);
    }
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    expect(statSync(join(folder, KEEPER_EXIT_FILE)).mode & 0o077).toBe(0);
  });
});

describe("the keeper's hub secret", () => {
  it("a client without the secret cannot drive the keeper or drop the hub", async () => {
    const folder = folderFor(
      `require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
         console.log(JSON.stringify({ echo: l }));
       });`,
    );
    const k = keep(folder);
    const hub = await client(folder);
    hub.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    const wrong = await client(folder);
    wrong.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0, secret: "cd".repeat(32) });
    await wrong.closed;
    const silent = await client(folder);
    silent.say({ t: "in", line: "evil", user: true }); // a first line that is not a hello
    await silent.closed;
    const noSecret = await client(folder);
    noSecret.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0, secret: 7 });
    await noSecret.closed;
    // the real hub was never dropped, and only its line reaches the CLI
    expect(hub.sock.destroyed).toBe(false);
    hub.say({ t: "in", line: "mine", user: true });
    await until(() => expect(hub.outs()).toEqual([[0, '{"echo":"mine"}']]));
    expect(lines()).toEqual(['{"echo":"mine"}']);
    hub.say({ t: "close", graceMs: 300 });
    await k.done;
  });

  it("a spec with no secret starts no CLI", async () => {
    const folder = folderFor(`setInterval(() => {}, 1000);`, { secret: "not-hex" });
    const k = keep(folder);
    await k.done;
    expect(readKeeperExit(folder)).toMatchObject({ code: null, lastStderr: NO_SECRET_TEXT });
    expect(existsSync(join(folder, "cli.pid"))).toBe(false);
  });
});

describe("the CLI's process group", () => {
  it("a CLI's child process ends with it", async () => {
    const folder = folderFor(
      `const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" });
       console.log(c.pid);
       process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(lines()).toHaveLength(1));
    const childPid = Number(lines()[0]);
    expect(() => process.kill(childPid, 0)).not.toThrow();
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    await until(() => expect(() => process.kill(childPid, 0)).toThrow());
  });
});

describe("the hub-absent limit", () => {
  it("an idle keeper ends its CLI after the limit, and an attached hub holds it off", async () => {
    const stays = `process.stdin.resume(); setInterval(() => {}, 1000);`;
    const alone = folderFor(stays, { hubAbsentMs: 200 });
    const first = keep(alone);
    await first.done;
    expect(readKeeperExit(alone)).toEqual({
      code: null,
      signal: "SIGTERM",
      at: expect.any(Number),
      lastStderr: HUB_ABSENT_TEXT,
    });

    const folder = folderFor(stays, { hubAbsentMs: 200 });
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await new Promise((r) => setTimeout(r, 600));
    expect(readKeeperExit(folder)).toBeNull();
    c.sock.destroy(); // the hub leaves: the limit starts again
    await k.done;
    expect(readKeeperExit(folder)).toMatchObject({
      signal: "SIGTERM",
      lastStderr: HUB_ABSENT_TEXT,
    });
  });
});

describe("parsePsLine", () => {
  it("reads ps's lstart and command", () => {
    expect(parsePsLine("Thu Oct 23 12:34:56 2026 /usr/bin/node keeper-cli.ts /x/k1\n")).toEqual({
      startedAt: new Date(2026, 9, 23, 12, 34, 56).getTime(),
      command: "/usr/bin/node keeper-cli.ts /x/k1",
    });
    expect(parsePsLine("  Fri Oct  3 01:02:03 2026 sleep 30")).toEqual({
      startedAt: new Date(2026, 9, 3, 1, 2, 3).getTime(),
      command: "sleep 30",
    });
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("not a ps line")).toBeNull();
    expect(parsePsLine("Thu Xxx 23 12:34:56 2026 sleep")).toBeNull();
  });
});

describe("endKeeper", () => {
  it("does not signal a live pid whose command is not the keeper's", async () => {
    const folder = folderFor(`setInterval(() => {}, 1000);`);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      // a pid file that names a live process that is neither the run's keeper nor its CLI
      writeFileSync(join(folder, "keeper.pid"), `${sleeper.pid}\n`);
      writeFileSync(join(folder, "cli.pid"), `${sleeper.pid}\n`);
      const said: string[] = [];
      expect(await endKeeper(folder, 200, (m) => said.push(m))).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(sleeper.pid as number, 0)).not.toThrow();
      expect(sleeper.exitCode).toBeNull();
      expect(said).toHaveLength(2);
      expect(said[0]).toContain(`pid ${sleeper.pid} in keeper.pid is not the run's keeper`);
      expect(said[1]).toContain(`pid ${sleeper.pid} in cli.pid is not the run's CLI`);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("does not signal a process that started after its pid file was written", async () => {
    const folder = folderFor(`setInterval(() => {}, 1000);`);
    const k = keep(folder);
    await until(() => expect(readPidFile(folder, "cli.pid")).not.toBeNull());
    const cliPid = readPidFile(folder, "cli.pid") as number;
    // the file is older than the process: the pid has been reused since it was written
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(folder, "cli.pid"), old, old);
    writeFileSync(join(folder, "keeper.pid"), "99999999\n");
    expect(await endKeeper(folder, 100)).toBe(true);
    expect(() => process.kill(cliPid, 0)).not.toThrow();
    utimesSync(join(folder, "cli.pid"), new Date(), new Date());
    expect(await endKeeper(folder, 200)).toBe(true);
    await k.done;
  });

  it("is true at once for a folder with no live pids", async () => {
    const folder = join(dir, "empty");
    mkdirSync(folder);
    expect(await endKeeper(folder, 100)).toBe(true);
  });

  it("ends the live pids its files name: SIGTERM first, SIGKILL after the wait", async () => {
    const folder = folderFor(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    const k = keep(folder);
    await until(() => expect(readPidFile(folder, "cli.pid")).not.toBeNull());
    const cliPid = readPidFile(folder, "cli.pid") as number;
    // the keeper here is this very process: a file naming a dead pid stands in for it
    writeFileSync(join(folder, "keeper.pid"), "99999999\n");
    expect(await endKeeper(folder, 200)).toBe(true);
    expect(() => process.kill(cliPid, 0)).toThrow();
    await k.done;
  });
});
