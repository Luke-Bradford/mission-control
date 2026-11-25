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
 * its screen); an app on a free local port reads as not answering; and the workspace is closed
 * again through the cmux command, never through the hub. It prints the raw `list-status`,
 * `list-workspaces`, `sessions` and `agent inbox` output, to check the fake against.
 * Exit code 0 is a pass.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCmux } from "../../src/runtime/cmux.ts";
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

  log("raw output, to check fake-cmux.mjs against:");
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
  store.close();
  rmSync(root, { recursive: true, force: true });
}
log(failures.length === 0 ? "PASS" : `FAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
