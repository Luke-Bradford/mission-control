/**
 * A live check of a Claude seat in cmux: real cmux, real `claude`, a brand-new folder Claude has
 * never trusted. The unit tests run against `test/fixtures/fake-cmux.mjs` and screens typed into
 * the tests, which cannot show what real cmux and real Claude print. Run this on the Mac that runs
 * the hub, with the hub's own node, before any change to `src/runtime/cmux*.ts` merges:
 *
 *   cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-live-check.ts
 *
 * It opens one workspace and passes only if: the hub moves the folder-trust cursor to "Yes" and
 * confirms; the hub sees the session; a first turn ends; a tool that must ask for permission is
 * refused by the hub, the seat is told why and never shows as waiting on a person; and the
 * workspace is closed. It runs the cheapest model with the seat's isolation flags.
 * Exit code 0 is a pass. It leaves a project folder under ~/.claude/projects for its temp folder.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CREW_ISOLATION_FLAGS } from "@mc/core";
import { type Cmux, createCmux } from "../../src/runtime/cmux.ts";
import { CMUX_TOOL_REFUSED_TEXT, startCmuxSession } from "../../src/runtime/cmux-session.ts";

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
const until = async (cond: () => boolean, ms: number) => {
  for (const s = Date.now(); !cond(); ) {
    if (Date.now() - s > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
};

const nodeDir = dirname(process.execPath);
const real = createCmux(["cmux"], (m) => log(`cmux: ${m}`));
// every key the hub sends is kept: the trust prompt must be answered by Down before Enter
const keys: string[] = [];
const cmux: Cmux = {
  ...real,
  sendKey: (ws, key, force) => {
    keys.push(key);
    return real.sendKey(ws, key, force);
  },
};
const name = `live-check ${randomUUID().slice(0, 8)} · demo#1`;
const workspaces = () =>
  execFileSync("cmux", ["workspace", "list"], {
    encoding: "utf8",
    env: { ...process.env, CMUX_QUIET: "1" },
  });
let session: ReturnType<typeof startCmuxSession> | null = null;
let closing = false;
const tidy = async () => {
  if (closing) return;
  closing = true;
  await session?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void tidy().then(() => process.exit(130)));

try {
  await real.ensure();
  log(`node ${process.version} from ${nodeDir}`);
  const sessionId = randomUUID();
  const events: { kind: string }[] = [];
  session = startCmuxSession({
    cmux,
    name,
    cwd: work,
    command: "claude",
    args: [
      "--session-id",
      sessionId,
      "--model",
      "haiku",
      ...CREW_ISOLATION_FLAGS,
      // as a seat is started: its tools named, and only some of their uses allowed. `touch` is not
      // among them, so the tool the check asks for opens Claude's permission dialog.
      "--tools",
      "Bash,Read",
      "--allowedTools",
      "Read,Bash(ls:*)",
      "--permission-mode",
      "default",
    ],
    env: { HOME: process.env.HOME as string },
    dir: join(root, "run"),
    transcriptPath: join(root, "transcript.jsonl"),
    cliSessionId: sessionId,
    messageDir: join(root, "messages"),
    nodeDir,
    log: (m) => log(`session: ${m}`),
  });
  session.on((e) => {
    events.push(e);
    if (e.kind !== "output") log(`event ${JSON.stringify(e).slice(0, 160)}`);
  });
  await session.ready;
  check(session.alive, "the hub sees Claude running");
  // Enter goes only once a fresh read of the screen shows the cursor on "Yes"; a slow redraw can
  // take a second Down first
  check(
    /^(down,)+enter(,|$)/.test(keys.join(",")),
    `the hub moved the trust cursor to "Yes", then confirmed (keys: ${keys.join(",") || "none"})`,
  );
  check(workspaces().includes(name), "the workspace is open under its name");
  if (session.alive) {
    const transcript = () =>
      existsSync(join(root, "transcript.jsonl"))
        ? readFileSync(join(root, "transcript.jsonl"), "utf8")
        : "";
    const said = (text: string) =>
      transcript()
        .split("\n")
        .some((l) => l.includes('"type":"assistant"') && l.includes(text));
    const results = () => events.filter((e) => e.kind === "result").length;
    session.send("Reply with the single word PINEAPPLE and nothing else.");
    check(await until(() => results() >= 1, 90_000), "the first turn ended");
    check(said("PINEAPPLE"), "Claude's reply reached the run's transcript");
    session.send(
      "Use your Bash tool to run exactly this: touch made-by-live-check.txt   If the tool call is refused or denied, reply NOT ALLOWED and stop; do not try another way.",
    );
    check(
      await until(() => transcript().includes(CMUX_TOOL_REFUSED_TEXT), 120_000),
      "the hub refused the permission dialog and told the seat why",
    );
    check(await until(() => results() >= 2, 120_000), "the turn with a refused tool ended");
    check(!existsSync(join(work, "made-by-live-check.txt")), "the refused tool did not run");
    check(
      events.filter((e) => e.kind === "needs-input").length === 0,
      "the seat never showed as waiting on a person",
    );
  }
  // what Claude said, for whoever reads a failure
  if (existsSync(join(root, "transcript.jsonl")))
    for (const l of readFileSync(join(root, "transcript.jsonl"), "utf8").split("\n")) {
      try {
        const j = JSON.parse(l) as { type?: string; message?: { content?: unknown } };
        if (j.type !== "assistant" && j.type !== "user") continue;
        const c = j.message?.content;
        const text =
          typeof c === "string"
            ? c
            : (Array.isArray(c) ? c : [])
                .map((b: { type?: string; text?: string; name?: string; content?: unknown }) =>
                  b.type === "text"
                    ? b.text
                    : `[${b.type}${b.name ? ` ${b.name}` : ""}${typeof b.content === "string" ? `: ${b.content.slice(0, 120)}` : ""}]`,
                )
                .join(" ");
        log(`  ${j.type}: ${String(text).replace(/\s+/g, " ").slice(0, 220)}`);
      } catch {
        // not a JSON line
      }
    }
  await session.close();
  // cmux takes a moment to drop a closed workspace from its list
  check(await until(() => !workspaces().includes(name), 15_000), "the workspace is closed");
} finally {
  await tidy();
}
console.log(failures.length === 0 ? "\nPASS" : `\nFAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
