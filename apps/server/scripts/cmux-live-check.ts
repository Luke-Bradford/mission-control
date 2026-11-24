/**
 * A live check of a Claude seat in cmux: real cmux, real `claude`, a brand-new folder Claude has
 * never trusted. The unit tests run against `test/fixtures/fake-cmux.mjs`, which cannot show what
 * real cmux and real Claude print, so run this on the Mac that runs the hub before any change to
 * `src/runtime/cmux*.ts` merges:
 *
 *   cd apps/server && node --experimental-strip-types scripts/cmux-live-check.ts
 *
 * It opens one workspace ("live-check · demo#1"), and passes only if: the hub answers the
 * folder-trust prompt and sees the session; a first turn ends; a tool call that must ask for
 * permission is refused by the hub and the seat is told to carry on; the workspace is closed.
 * It spends a few cents on the cheapest model. Exit code 0 is a pass.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCmux } from "../src/runtime/cmux.ts";
import { startCmuxSession } from "../src/runtime/cmux-session.ts";

const root = mkdtempSync(join(tmpdir(), "mc-cmux-live-"));
const work = join(root, "work");
mkdirSync(join(work, ".claude"), { recursive: true });
writeFileSync(join(work, "CLAUDE.md"), "# A folder for the cmux live check\n");
// a seat's worktree pre-approves a tool, which is what makes Claude's trust prompt warn
writeFileSync(
  join(work, ".claude", "settings.json"),
  JSON.stringify({ permissions: { allow: ["Edit(/CLAUDE.md)"] } }),
);
execFileSync("git", ["init", "-q"], { cwd: work });

const t0 = Date.now();
const log = (m: string) =>
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const events: { kind: string }[] = [];
const until = async (cond: () => boolean, ms: number) => {
  for (const s = Date.now(); !cond(); ) {
    if (Date.now() - s > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
};

const cmux = createCmux(["cmux"], (m) => log(`cmux: ${m}`));
await cmux.ensure();
const sessionId = randomUUID();
const session = startCmuxSession({
  cmux,
  name: "live-check · demo#1",
  cwd: work,
  command: "claude",
  args: [
    "--session-id",
    sessionId,
    "--model",
    "haiku",
    "--permission-mode",
    "default",
    // the one tool the check asks for must open Claude's permission dialog
    "--settings",
    JSON.stringify({ permissions: { ask: ["Bash(touch:*)"] } }),
  ],
  env: { HOME: process.env.HOME as string },
  dir: join(root, "run"),
  transcriptPath: join(root, "transcript.jsonl"),
  cliSessionId: sessionId,
  messageDir: join(root, "messages"),
  nodeDir: dirname(process.execPath),
  log: (m) => log(`session: ${m}`),
});
session.on((e) => {
  events.push(e);
  if (e.kind !== "output") log(`event ${JSON.stringify(e).slice(0, 160)}`);
});
await session.ready;
check(session.alive, "the hub answered the trust prompt and sees Claude running");
if (session.alive) {
  const results = () => events.filter((e) => e.kind === "result").length;
  session.send("Reply with the single word READY and nothing else.");
  check(await until(() => results() >= 1, 90_000), "the first turn ended");
  session.send(
    "Use your Bash tool to run exactly this: touch made-by-live-check.txt   If the tool call is refused or denied, reply NOT ALLOWED and stop; do not try another way.",
  );
  check(await until(() => results() >= 2, 120_000), "the turn with a refused tool ended");
  check(!existsSync(join(work, "made-by-live-check.txt")), "the refused tool did not run");
  const transcript = existsSync(join(root, "transcript.jsonl"))
    ? readFileSync(join(root, "transcript.jsonl"), "utf8")
    : "";
  check(transcript.includes("READY"), "Claude's lines reached the run's transcript");
  check(transcript.includes("Mission Control refused that tool call"), "the seat was told why");
}
await session.close();
// cmux takes a moment to drop a closed workspace from its list
const listed = () =>
  execFileSync("cmux", ["workspace", "list"], { encoding: "utf8" }).includes("live-check");
const left = !(await until(() => !listed(), 15_000));
check(!left, "the workspace is closed");
rmSync(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nPASS" : `\nFAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
