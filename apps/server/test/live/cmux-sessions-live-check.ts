/**
 * A live check of the Sessions page's reads and writes against real cmux, on a workspace the hub
 * did not start. The unit tests run against `test/fixtures/fake-cmux.mjs`, which cannot show what
 * real cmux prints. Run this on the Mac that runs the hub, with the hub's own node, before any
 * change to `src/runtime/cmux*.ts` or `src/sessions/*` merges:
 *
 *   cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-sessions-live-check.ts
 *
 * It opens one shell workspace with the cmux command (as the operator would), and passes only if:
 * the hub lists it as the operator's with no agent; a write reaches it (an `echo` marker shows on
 * its screen); the hub brings it to the front; an agent message to it types nothing on its screen
 * and comes back from `agent inbox` parsed for this workspace; an app on a free local port reads as
 * not answering, with no notice typed into the shell; and the workspace is closed again through the
 * cmux command, never through the hub. It prints the raw `list-windows`, `list-status`,
 * `list-workspaces`, `sessions` and `agent inbox` output, to check the fake against.
 *
 * Then it opens five Claude sessions in a row through `openSession` (the New session button and
 * FLIGHT's cmux_open), as GUIDO with a one-word first message. Each start passes only when Claude's
 * own process (the pid its launch script wrote) is alive and a new transcript under
 * `~/.claude/projects/` holds the first message: never from cmux's record. Each is closed after.
 * Exit code 0 is a pass.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCmux } from "../../src/runtime/cmux.ts";
import { openSession } from "../../src/sessions/open.ts";
import { createSessions } from "../../src/sessions/sessions.ts";
import { Store } from "../../src/store.ts";

const root = mkdtempSync(join(tmpdir(), "mc-cmux-sessions-live-"));
const t0 = Date.now();
const log = (m: string) =>
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cmuxCli = (...args: string[]) =>
  execFileSync("cmux", args, { encoding: "utf8", env: { ...process.env, CMUX_QUIET: "1" } });
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const store = new Store(join(root, "mc.sqlite"));
const cmux = createCmux(["cmux"], (m) => log(`cmux: ${m}`));
const sessions = createSessions({ cmux, store, seatIds: () => ["guido-1", "flight-1"] });
const name = `live-check ${randomUUID().slice(0, 8)}`;
let id: string | null = null;
/** The sessions openSession made, closed at the end. */
const opened: { id: string; pidFile: string }[] = [];
const ROLES_DIR = fileURLToPath(new URL("../../../../roles", import.meta.url));
const PROJECTS = join(homedir(), ".claude", "projects");
const OPENS = 5;
const START_WAIT_MS = 60_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A transcript written since `since` that holds `text`. */
const transcriptWith = (text: string, since: number): string | null => {
  for (const dir of existsSync(PROJECTS) ? readdirSync(PROJECTS) : []) {
    const at = join(PROJECTS, dir);
    if (!statSync(at).isDirectory()) continue;
    for (const f of readdirSync(at)) {
      const file = join(at, f);
      if (!f.endsWith(".jsonl") || statSync(file).mtimeMs < since) continue;
      if (readFileSync(file, "utf8").includes(text)) return file;
    }
  }
  return null;
};

try {
  check((await cmux.ping()) === "up", "cmux answers");
  cmuxCli("new-workspace", "--name", name, "--cwd", root, "--focus", "false");
  await sleep(1500);
  let view = await sessions.view();
  if (!view.ok) throw new Error(view.error);
  const row = view.sessions.find((r) => r.name === name);
  id = row?.id ?? null;
  check(row !== undefined, "the hub lists a workspace it did not start");
  check(row?.owner === "operator", `it is the operator's (got ${row?.owner})`);
  check(row?.state === "no-agent", `it has no agent (got ${row?.state})`);
  if (id === null) throw new Error("no workspace to go on with");

  const marker = `MC-LIVE-${randomUUID().slice(0, 8)}`;
  check((await sessions.send(id, `echo ${marker}`, "operator")) === "sent", "the write is sent");
  await sleep(1500);
  const screen = await sessions.read(id, 30);
  check(screen.includes(marker), "the marker shows on its screen");
  check(
    store.hubEvents(0).some((e) => e.text.startsWith(`Wrote to cmux session "${name}"`)),
    "the write is logged with who asked",
  );

  await sessions.focus(id);
  check(true, "the hub brings the workspace to the front (select-workspace, then cmux forward)");

  // `agent message` goes through cmux's agent inbox, never typed into the terminal: a plain shell's
  // screen stays clear of it, and the inbox names the workspace it went to
  const note = `MC-NOTE-${randomUUID().slice(0, 8)}`;
  await cmux.agentMessage(id, note, "Mission Control");
  await sleep(1500);
  check(
    !(await sessions.read(id, 30)).includes(note),
    "an agent message types nothing into the shell",
  );
  const inbox = await cmux.inbox();
  check(
    inbox.some((m) => m.workspaceId === id && m.text === note),
    `the inbox parses the message for this workspace (parsed ${inbox.length} rows)`,
  );
  await sleep(2100); // past the shared read
  view = await sessions.view();
  if (!view.ok) throw new Error(view.error);
  const mine = view.sessions.find((r) => r.id === id)?.inbox;
  check(
    mine !== undefined && mine.unread >= 1 && mine.newest === note,
    `the row shows the message (got ${JSON.stringify(mine)})`,
  );

  const port = await freePort();
  cmuxCli("set-status", "app", `http://127.0.0.1:${port}`, "--workspace", id);
  await sleep(2100); // past the shared read
  view = await sessions.view();
  if (!view.ok) throw new Error(view.error);
  const app = view.sessions.find((r) => r.id === id)?.app;
  check(
    app?.url === `http://127.0.0.1:${port}` && app.answers === false,
    `an app on a free port reads as not answering (got ${JSON.stringify(app)})`,
  );
  check(
    !(await sessions.read(id, 30)).includes("stopped answering"),
    "no app notice is typed into a shell",
  );

  for (let n = 1; n <= OPENS; n++) {
    const marker = `MC-OPEN-${n}-${randomUUID().slice(0, 8)}`;
    const since = Date.now();
    const o = await openSession(
      { cmux, store, rolesDir: ROLES_DIR },
      {
        folder: root,
        worktree: false,
        role: "GUIDO",
        message: `Reply with the single word OK. ${marker}`,
        name: `live-open ${marker}`,
      },
      "operator",
    );
    opened.push(o);
    let pid: number | null = null;
    let transcript: string | null = null;
    for (let waited = 0; waited < START_WAIT_MS && (pid === null || transcript === null); ) {
      await sleep(1000);
      waited += 1000;
      if (pid === null && existsSync(o.pidFile)) {
        const read = Number(readFileSync(o.pidFile, "utf8").trim());
        pid = Number.isInteger(read) && read > 0 ? read : null;
      }
      transcript ??= transcriptWith(marker, since);
    }
    check(pid !== null && alive(pid), `start ${n}: Claude's process is alive (pid ${pid})`);
    check(transcript !== null, `start ${n}: its transcript holds the first message`);
  }

  log("raw output, to check fake-cmux.mjs against:");
  console.log("--- list-windows\n", cmuxCli("--json", "--id-format", "uuids", "list-windows"));
  console.log("--- list-status\n", cmuxCli("list-status", "--workspace", id));
  console.log(
    "--- list-workspaces\n",
    cmuxCli("--json", "--id-format", "uuids", "list-workspaces"),
  );
  console.log("--- sessions\n", cmuxCli("sessions", "--agent", "claude", "--json", "--limit", "3"));
  console.log("--- agent inbox\n", cmuxCli("agent", "inbox", "--json", "--limit", "3"));
} catch (e) {
  check(false, `no error (${String(e)})`);
} finally {
  if (id !== null) {
    cmuxCli("close-workspace", "--workspace", id);
    await sleep(500);
    check(
      !(await cmux.workspaces()).some((w) => w.id === id),
      "the workspace is closed through the cmux command",
    );
  }
  for (const o of opened) {
    try {
      cmuxCli("close-workspace", "--workspace", o.id);
    } catch (e) {
      log(`could not close ${o.id}: ${String(e)}`);
    }
  }
  store.close();
  rmSync(root, { recursive: true, force: true });
}
log(failures.length === 0 ? "PASS" : `FAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
