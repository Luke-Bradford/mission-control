/**
 * A live check of the cmux wrapper (`src/runtime/cmux.ts`) against real cmux and real `claude`, in a
 * workspace the hub opens itself, as it opens a seat's. The unit tests run against
 * `test/fixtures/fake-cmux.mjs`, which cannot show what real cmux and real Claude print. Run this on
 * the Mac that runs the hub, with the hub's own node, before any change to `src/runtime/cmux*.ts`
 * merges, together with `cmux-sessions-live-check.ts` (a workspace the hub did not start):
 *
 *   cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-live-check.ts
 *
 * It opens one workspace running Claude in a brand-new folder, and passes only if: the hub finds the
 * workspace under its name; it gets past Claude's folder-trust prompt with keys alone; `cmux
 * sessions` names the agent in that workspace; a pasted message gets a reply in Claude's transcript;
 * a sidebar status set through the cmux command reads back; and the hub closes the workspace. It runs
 * the cheapest model with the seat's isolation flags. Exit code 0 is a pass. It leaves a project
 * folder under ~/.claude/projects for its temp folder.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_ISOLATION_FLAGS } from "@mc/core";
import { createCmux } from "../../src/runtime/cmux.ts";

const root = mkdtempSync(join(tmpdir(), "mc-cmux-live-"));
const work = join(root, "work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "CLAUDE.md"), "# A folder for the cmux live check\n");
execFileSync("git", ["init", "-q"], { cwd: work });

const t0 = Date.now();
const log = (m: string) =>
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => Promise<boolean> | boolean, ms: number) => {
  for (const s = Date.now(); !(await cond()); ) {
    if (Date.now() - s > ms) return false;
    await sleep(500);
  }
  return true;
};
const cmuxCli = (...args: string[]) =>
  execFileSync("cmux", args, { encoding: "utf8", env: { ...process.env, CMUX_QUIET: "1" } });

const cmux = createCmux(["cmux"], (m) => log(`cmux: ${m}`));
const name = `live-check ${randomUUID().slice(0, 8)} · demo#1`;
const sessionId = randomUUID();
let id: string | null = null;
let closing = false;
const tidy = async () => {
  if (closing) return;
  closing = true;
  if (id !== null) await cmux.close(id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void tidy().then(() => process.exit(130)));

try {
  await cmux.ensure();
  const command = [
    "claude",
    "--session-id",
    sessionId,
    "--model",
    "haiku",
    ...CREW_ISOLATION_FLAGS,
    "--tools",
    "Read",
    "--permission-mode",
    "default",
  ].join(" ");
  id = await cmux.newWorkspace({ name, cwd: work, command });
  check(
    (await cmux.workspaces()).some((w) => w.id === id && w.name === name),
    "the hub finds the workspace under its name",
  );
  const ws = id;

  // the folder is new to Claude: its trust prompt is answered with keys, never typed text
  const trusted = await until(async () => {
    const screen = await cmux.readScreen(ws, 40);
    // Claude's empty input box, or its shortcuts hint, means it is ready for a message
    if (!/trust/i.test(screen))
      return /\? for shortcuts/.test(screen) || /^\s*│?\s*[>❯]\s*│?\s*$/m.test(screen);
    if (!/[❯>]\s*1\.\s*Yes/i.test(screen)) await cmux.sendKey(ws, "down");
    else await cmux.sendKey(ws, "enter");
    await sleep(1000);
    return false;
  }, 60_000);
  check(trusted, "the hub got past Claude's folder-trust prompt");

  const agent = async () => (await cmux.agents()).find((a) => a.workspaceId === ws);
  check(
    await until(async () => (await agent()) !== undefined, 30_000),
    "cmux sessions names the agent in the workspace",
  );
  const found = await agent();
  log(`agent record: ${JSON.stringify(found)}`);
  check(
    found?.cwd === null || found?.cwd?.endsWith("work") === true,
    "the agent's folder is the workspace's",
  );

  check(
    (await cmux.send(ws, "Reply with the single word PINEAPPLE and nothing else.")) === "sent",
    "the message is sent",
  );
  const transcript = () => {
    const path = found?.transcriptPath;
    return path != null && existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  check(
    await until(
      () =>
        transcript()
          .split("\n")
          .some((l) => l.includes('"type":"assistant"') && l.includes("PINEAPPLE")),
      90_000,
    ),
    "Claude's reply reached its transcript",
  );
  check(
    await until(async () => (await agent())?.lifecycle === "idle", 30_000),
    "the agent reads as idle once the turn ends",
  );

  cmuxCli("set-status", "task", "live check", "--workspace", ws);
  check((await cmux.statuses(ws)).task === "live check", "a sidebar status reads back");

  log("raw output, to check fake-cmux.mjs against:");
  console.log("--- read-screen\n", await cmux.readScreen(ws, 15));
  console.log("--- list-status\n", cmuxCli("list-status", "--workspace", ws));

  await cmux.close(ws);
  check(
    await until(async () => !(await cmux.workspaces()).some((w) => w.id === ws), 15_000),
    "the hub closed the workspace",
  );
  id = null;
} catch (e) {
  check(false, `no error (${String(e)})`);
} finally {
  await tidy();
}
console.log(failures.length === 0 ? "\nPASS" : `\nFAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
