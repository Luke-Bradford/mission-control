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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_APPROVAL_DECISION } from "../src/runtime/codex-wire.ts";
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
import { expectNoLeftovers } from "./leftovers.ts";

let dir: string;
let transcript: string;
let folders = 0;
const running: Promise<void>[] = [];
const SECRET = "ab".repeat(32);
const CLI_ID = "11111111-2222-4333-8444-555555555555";

/** One tmp root for every folder this file makes: `afterAll` looks for processes that name it. */
let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mc-kp-")));
});
afterAll(async () => {
  try {
    await expectNoLeftovers(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(root, "t-")));
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
    // the folder is the last argument, so the leftover check finds a CLI that outlives its test
    args: ["-e", script, CLI_ID, dir],
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
      `process.stdin.once("data", () => { console.log("a"); console.log("b"); });
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
    c.say({ t: "in", line: "write", user: false });
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
      `process.stdin.once("data", () => { console.log("a"); console.log("b"); });
       process.stdin.on("end", () => process.exit(0));`,
    );
    const k = keep(folder, {
      write: () => {
        throw new Error("disk full");
      },
    });
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "write", user: false });
    await until(() => expect(c.outs()).toHaveLength(2));
    c.say({ t: "close", graceMs: 300 });
    await k.done;
    await c.closed;
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
      parsedResults: true,
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
       require("node:readline").createInterface({ input: process.stdin }).on("line", out);
       process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));`,
    );
    const k = keep(folder);
    const a = await client(folder);
    a.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(a.outs()).toHaveLength(3));
    a.say({ t: "in", line: "l3", user: false });
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
    await until(() => expect(b.outs()).toHaveLength(2));
    b.say({ t: "in", line: "l4", user: false });
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

  it("ends the turn at a result whose type is not its first key, as Claude 2.1.302 prints it", async () => {
    // the real CLI's result starts {"duration_api_ms":…; a keeper that matched a {"type":"result"
    // prefix said awaiting forever, so FLIGHT was never woken after a hub restart (#798)
    const folder = folderFor(
      `require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
         console.log(JSON.stringify({ type: "assistant", text: '"type":"result"' }));
         console.log(JSON.stringify({ duration_api_ms: 5, stop_reason: "end_turn", type: "result" }));
       });`,
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "hi", user: true });
    await until(() => expect(c.outs()).toHaveLength(2));
    const d = await client(folder);
    expect(d.msgs[0]).toMatchObject({ lines: 2, awaiting: false, parsedResults: true });
    d.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 2 });
    d.say({ t: "close", graceMs: 300 });
    await k.done;
  });

  it("does not end the turn at a line that only quotes a result", async () => {
    const folder = folderFor(
      `require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
         console.log(JSON.stringify({ type: "assistant", text: '{"type":"result"}' }));
       });`,
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "hi", user: true });
    await until(() => expect(c.outs()).toHaveLength(1));
    const d = await client(folder);
    expect(d.msgs[0]).toMatchObject({ lines: 1, awaiting: true });
    d.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 1 });
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
      lastStderrAt: expect.any(Number),
      endReason: null,
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
      lastStderrAt: null,
      endReason: HUB_ABSENT_TEXT,
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
      lastStderrAt: null,
      endReason: HUB_ABSENT_TEXT,
    });
  });
});

describe("parsePsLine", () => {
  it("reads ps's lstart and command", () => {
    expect(parsePsLine("Thu Oct 23 12:34:56 2026 /usr/bin/node keeper-cli.ts /x/k1\n")).toEqual({
      startedAt: Date.UTC(2026, 9, 23, 12, 34, 56),
      command: "/usr/bin/node keeper-cli.ts /x/k1",
    });
    expect(parsePsLine("  Fri Oct  3 01:02:03 2026 sleep 30")).toEqual({
      startedAt: Date.UTC(2026, 9, 3, 1, 2, 3),
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

  it("is false, and signals nothing, for a live pid it cannot identify (a spec with no cliSessionId)", async () => {
    const folder = folderFor(`setInterval(() => {}, 1000);`);
    // a keeper of before the session id was in the spec
    const spec = JSON.parse(readFileSync(join(folder, KEEPER_SPEC_FILE), "utf8"));
    delete spec.cliSessionId;
    writeFileSync(join(folder, KEEPER_SPEC_FILE), JSON.stringify(spec));
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(join(folder, "cli.pid"), `${sleeper.pid}\n`);
      const said: string[] = [];
      expect(await endKeeper(folder, 200, (m) => said.push(m))).toBe(false);
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(sleeper.pid as number, 0)).not.toThrow();
      expect(sleeper.exitCode).toBeNull();
      expect(said).toHaveLength(1);
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
    const folder = folderFor(
      `process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000);`,
    );
    const k = keep(folder);
    await until(() => expect(readPidFile(folder, "cli.pid")).not.toBeNull());
    await until(() => expect(lines()).toEqual(["up"]));
    const cliPid = readPidFile(folder, "cli.pid") as number;
    // the keeper here is this very process: a file naming a dead pid stands in for it
    writeFileSync(join(folder, "keeper.pid"), "99999999\n");
    expect(await endKeeper(folder, 200)).toBe(true);
    await k.done;
    expect(() => process.kill(cliPid, 0)).toThrow();
  });
});

describe("Codex keeper turns and old specs", () => {
  it("persists activity timestamps and approval decisions for replay", async () => {
    const folder = folderFor(
      `
      console.log(JSON.stringify({ method: "item/started", params: { item: { id: "cmd", type: "commandExecution", command: "pwd" } } }));
      require("node:readline").createInterface({ input: process.stdin }).on("line", () => {});
    `,
      { turnEnd: "codex" },
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", from: 0 });
    await until(() => expect(c.outs()).toHaveLength(1));
    c.say({ t: "in", line: JSON.stringify({ id: 7, result: { decision: "accept" } }) });
    c.say({
      t: "in",
      line: JSON.stringify({ id: 8, result: { action: "decline", content: null } }),
    });
    await until(() => expect(c.outs()).toHaveLength(3));
    const recorded = lines().map((line) => JSON.parse(line));
    expect(recorded.map((line) => line.method)).toEqual([
      "item/started",
      CODEX_APPROVAL_DECISION,
      CODEX_APPROVAL_DECISION,
    ]);
    expect(recorded.every((line) => Number.isFinite(Date.parse(line.timestamp)))).toBe(true);
    expect(recorded.slice(1).map((line) => line.params.decision)).toEqual(["accept", "decline"]);
    const reattached = await client(folder);
    reattached.say({ t: "hello", from: 0 });
    await until(() => expect(reattached.outs()).toEqual(c.outs()));
    reattached.say({ t: "close", graceMs: 100 });
    await k.done;
  });

  it("identifies a Codex process by its marker instead of cliSessionId", async () => {
    const marker = 'mc_run="run-identity"';
    const folder = folderFor("setInterval(() => {}, 1000);", {
      turnEnd: "codex",
      marker,
      cliSessionId: "not-in-argv",
    });
    const spec = JSON.parse(readFileSync(join(folder, KEEPER_SPEC_FILE), "utf8"));
    spec.args.push(marker);
    writeFileSync(join(folder, KEEPER_SPEC_FILE), JSON.stringify(spec));
    const k = keep(folder);
    await until(() => expect(readPidFile(folder, "cli.pid")).not.toBeNull());
    expect(await endKeeper(folder, 500)).toBe(true);
    await k.done;
    expect(readKeeperExit(folder)?.signal).toBe("SIGTERM");
  });

  it("attaches an old spec with Claude defaults", async () => {
    const folder =
      folderFor(`require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
      console.log(JSON.stringify({ type: "result" }));
    });`);
    const spec = JSON.parse(readFileSync(join(folder, KEEPER_SPEC_FILE), "utf8"));
    expect(spec.turnEnd).toBeUndefined();
    expect(spec.marker).toBeUndefined();
    const k = keep(folder);
    const a = await client(folder);
    a.say({ t: "hello", from: 0 });
    a.say({ t: "in", line: "hello", user: true });
    await until(() => expect(a.outs()).toHaveLength(1));
    const b = await client(folder);
    expect(b.msgs[0]).toMatchObject({ awaiting: false });
    b.say({ t: "hello", from: 1 });
    b.say({ t: "close", graceMs: 100 });
    await k.done;
  });

  it.each(["result", "error"])(
    "only a parsed turn completion or matching error ends awaiting: %s",
    async (ending) => {
      const marker = 'mc_run="run-1"';
      const folder = folderFor(
        `require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "turn/start") console.log(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === "finish") console.log(JSON.stringify(message.output));
      else console.log("ack");
    });`,
        { turnEnd: "codex", marker, cliSessionId: "not-the-marker" },
      );
      // Identity uses the marker even though cliSessionId is different.
      const spec = JSON.parse(readFileSync(join(folder, KEEPER_SPEC_FILE), "utf8"));
      spec.args.push(marker);
      writeFileSync(join(folder, KEEPER_SPEC_FILE), JSON.stringify(spec));
      const k = keep(folder);
      let c = await client(folder);
      c.say({ t: "hello", from: 0 });
      c.say({ t: "in", line: JSON.stringify({ id: 1, method: "initialize" }), user: true });
      await until(() => expect(c.outs()).toHaveLength(1));
      c = await client(folder);
      expect(c.msgs[0]).toMatchObject({ awaiting: false });
      c.say({ t: "hello", from: 1 });
      c.say({ t: "in", line: JSON.stringify({ id: 2, method: "turn/start" }), user: true });
      await until(() => expect(c.outs()).toHaveLength(1));
      c = await client(folder);
      expect(c.msgs[0]).toMatchObject({ awaiting: true });
      c.say({ t: "hello", from: 2 });
      c.say({ t: "in", line: JSON.stringify({ method: "finish", output: { id: 1, error: {} } }) });
      await until(() => expect(c.outs()).toHaveLength(1));
      c = await client(folder);
      expect(c.msgs[0]).toMatchObject({ awaiting: true });
      c.say({ t: "hello", from: 3 });
      const output =
        ending === "error"
          ? { id: 2, error: { code: -1 } }
          : { params: { turn: { status: "completed" } }, method: "turn/completed" };
      c.say({ t: "in", line: JSON.stringify({ method: "finish", output }) });
      await until(() => expect(c.outs()).toHaveLength(1));
      c = await client(folder);
      expect(c.msgs[0]).toMatchObject({ awaiting: false });
      c.say({ t: "hello", from: 4 });
      c.say({ t: "close", graceMs: 100 });
      await k.done;
    },
  );
});

describe("the compact transcript (#934)", () => {
  /** A Codex-style CLI that says one line of each kind once it is told to. */
  const noisy = `
    const big = "x".repeat(2 * 1024 * 1024);
    const say = (m) => console.log(JSON.stringify(m));
    process.stdin.once("data", () => {
      say({ method: "item/started", params: { item: { id: "c", type: "commandExecution" } } });
      say({ method: "item/commandExecution/outputDelta", params: { itemId: "c", delta: big.slice(0, 5000) } });
      say({ type: "control_response", response: { subtype: "success", request_id: "r", response: {
        categories: [{ name: "Messages", tokens: 5 }], totalTokens: 5, maxTokens: 100, gridRows: [[1]] } } });
      say({ method: "item/completed", params: { item: { id: "c", type: "commandExecution", aggregatedOutput: big } } });
      say({ method: "turn/completed" });
    });
    process.stdin.on("end", () => process.exit(0));
  `;
  const methods = (ls: (string | null)[]) =>
    ls.map((l) => (l === "" || l === null ? null : (JSON.parse(l) as { method?: string }).method));

  it("persists the compact form, delivers whole lines live, and replays the compact form", async () => {
    const folder = folderFor(noisy, { turnEnd: "codex" });
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "go", user: false });
    await until(() => expect(c.outs()).toHaveLength(5));
    // the attached hub hears the delta, the usage answer and the whole 2 MB output
    const live = c.outs().map(([, line]) => line as string);
    expect(live[1]).toContain("outputDelta");
    expect(live[2]).toContain("gridRows");
    expect((JSON.parse(live[3] as string).params.item.aggregatedOutput as string).length).toBe(
      2 * 1024 * 1024,
    );
    // the file holds a delta-free heartbeat for the delta, not the usage answer, and the output is
    // cut and marked
    const kept = lines();
    expect(methods(kept)).toEqual([
      "item/started",
      "item/commandExecution/outputDelta",
      "item/completed",
      "turn/completed",
    ]);
    expect(JSON.parse(kept[1] as string).params.delta).toBeUndefined();
    expect(readFileSync(transcript).length).toBeLessThan(20 * 1024);
    const item = JSON.parse(kept[2] as string).params.item;
    expect(item.outputTruncated).toEqual({ bytes: 2 * 1024 * 1024 });
    // a hub that comes back is numbered through the dropped lines and gets the compact form
    const again = await client(folder);
    again.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(again.outs()).toHaveLength(5));
    expect(again.outs().map(([n]) => n)).toEqual([0, 1, 2, 3, 4]);
    expect(again.outs()[2]?.[1]).toBe(""); // exactly empty, not null
    expect(methods(again.outs().map(([, l]) => l as string))).toEqual([
      "item/started",
      "item/commandExecution/outputDelta",
      null,
      "item/completed",
      "turn/completed",
    ]);
    // and one that had lines 0 to 2 asks from 3
    const resumed = await client(folder);
    resumed.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 3 });
    await until(() => expect(resumed.outs()).toHaveLength(2));
    expect(resumed.outs().map(([n]) => n)).toEqual([3, 4]);
    resumed.say({ t: "close", graceMs: 100 });
    await k.done;
  });

  const usage = `{ type: "control_response", response: { subtype: "success", request_id: "r", response: {
    categories: [{ name: "Messages", tokens: 5 }], totalTokens: 5, maxTokens: 100, gridRows: [[1]] } } }`;

  it("a dropped last line still has its number: a hub replaying from 0 gets the lines, then the exit", async () => {
    const folder = folderFor(
      `const say = (m) => console.log(JSON.stringify(m));
       process.stdin.once("data", () => {
         say({ method: "item/started", params: { item: { id: "c" } } });
         say(${usage});
       });
       process.stdin.on("end", () => process.exit(0));`,
      { turnEnd: "codex" },
    );
    const k = keep(folder);
    const a = await client(folder);
    a.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    a.say({ t: "in", line: "go", user: false });
    await until(() => expect(a.outs()).toHaveLength(2));
    const b = await client(folder);
    expect(b.msgs[0]).toMatchObject({ t: "hello", lines: 2 });
    b.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(b.outs()).toHaveLength(2));
    expect(b.outs()[1]).toEqual([1, ""]);
    b.say({ t: "close", graceMs: 300 });
    await k.done;
    await b.closed;
    expect(b.msgs.at(-1)).toEqual({ t: "exit", code: 0, signal: null });
  });

  it("a long replay with a compacted line arriving during it ends in order, the new line whole", async () => {
    const big = 300 * 1024;
    const folder = folderFor(
      `const say = (m) => console.log(JSON.stringify(m));
       for (let i = 0; i < 1500; i++) say({ method: "item/started", params: { item: { id: "c" + i } } });
       process.stdin.once("data", () => say({ method: "item/completed", params: { item: {
         id: "x", type: "commandExecution", aggregatedOutput: "y".repeat(${big}) } } }));
       process.stdin.on("end", () => process.exit(0));`,
      { turnEnd: "codex" },
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "go", user: false });
    await until(() => expect(c.outs()).toHaveLength(1501));
    expect(c.outs().map(([n]) => n)).toEqual(Array.from({ length: 1501 }, (_, i) => i));
    const last = JSON.parse(c.outs()[1500]?.[1] as string);
    expect(last.params.item.aggregatedOutput).toHaveLength(big);
    expect(lines()).toHaveLength(1501);
    expect(lines()[1500]?.length).toBeLessThan(20 * 1024);
    c.say({ t: "close", graceMs: 300 });
    await k.done;
  });

  it("with the transcript failing, dropped lines keep their numbers and the rest come from memory", async () => {
    const folder = folderFor(
      `const say = (m) => console.log(JSON.stringify(m));
       process.stdin.once("data", () => {
         say({ method: "item/started", params: { item: { id: "c" } } });
         say(${usage});
         say({ method: "turn/completed" });
       });
       process.stdin.on("end", () => process.exit(0));`,
      { turnEnd: "codex" },
    );
    const k = keep(folder, {
      write: () => {
        throw new Error("disk full");
      },
    });
    const a = await client(folder);
    a.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    a.say({ t: "in", line: "go", user: false });
    await until(() => expect(a.outs()).toHaveLength(3));
    expect(String(a.outs()[1]?.[1]).includes("gridRows")).toBe(true); // live: whole
    const b = await client(folder);
    b.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    await until(() => expect(b.outs()).toHaveLength(3));
    expect(b.outs().map(([n]) => n)).toEqual([0, 1, 2]);
    expect(b.outs()[1]?.[1]).toBe("");
    expect(methods([b.outs()[0]?.[1] as string, b.outs()[2]?.[1] as string])).toEqual([
      "item/started",
      "turn/completed",
    ]);
    b.say({ t: "close", graceMs: 300 });
    await k.done;
  });

  it("leaves a heartbeat for a long delta-only command, one per minute of it", async () => {
    const folder = folderFor(
      `const say = (m) => console.log(JSON.stringify(m));
       process.stdin.once("data", () => {
         for (let i = 0; i < 50; i++) say({ method: "item/commandExecution/outputDelta",
           params: { threadId: "t", turnId: "u", itemId: "c", delta: "line " + i } });
       });
       process.stdin.on("end", () => process.exit(0));`,
      { turnEnd: "codex" },
    );
    const k = keep(folder);
    const c = await client(folder);
    c.say({ t: "hello", version: KEEPER_PROTOCOL_VERSION, from: 0 });
    c.say({ t: "in", line: "go", user: false });
    await until(() => expect(c.outs()).toHaveLength(50));
    const kept = lines().map((l) => JSON.parse(l));
    expect(kept).toHaveLength(1);
    expect(kept[0].params).toEqual({ threadId: "t", turnId: "u", itemId: "c" });
    expect(Number.isFinite(Date.parse(kept[0].timestamp))).toBe(true);
    c.say({ t: "close", graceMs: 300 });
    await k.done;
  });
});
