/**
 * A live check of a Claude seat in cmux, started as the hub starts a build seat: real cmux, real
 * `claude`, and the seat's own arguments from `crewCliArgs` (its sandbox, settings, tool lists,
 * `--restricted` and MCP config), in a brand-new folder Claude has never trusted. A check that starts
 * Claude without a seat's sandbox and settings passed while every real seat start failed (25
 * November), so this one builds the arguments the same way `supervisor.ts` does. Run it on the Mac
 * that runs the hub, with the hub's own node, before any change to `src/runtime/cmux*.ts` merges,
 * beside `cmux-live-check.ts` (the wrapper alone):
 *
 *   cd apps/server && ~/.local/mc-node/<version>/bin/node --experimental-strip-types test/live/cmux-seat-live-check.ts
 *
 * It passes only if: the hub sees Claude up (by cmux's record, or by Claude's pid and its prompt when
 * cmux keeps none); a first turn ends and its reply reaches the run's transcript; a tool outside the
 * seat's allowlist is refused by the hub, the seat is told why and never shows as waiting on a
 * person; and the workspace closes. It says whether cmux kept a record of the session, which the hub
 * no longer needs. No hub runs here, so the seat's guard hook is a stand-in that allows every tool
 * and its MCP config names no server. Exit code 0 is a pass. It leaves a project folder under
 * ~/.claude/projects for its temp folder.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CREW_CLI_ENV, crewCliArgs } from "@mc/core";
import { type Cmux, createCmux } from "../../src/runtime/cmux.ts";
import {
  CMUX_TOOL_REFUSED_TEXT,
  claudeConfigDir,
  startCmuxSession,
} from "../../src/runtime/cmux-session.ts";

const root = mkdtempSync(join(tmpdir(), "mc-cmux-seat-live-"));
const work = join(root, "work");
const tempRoot = join(root, "tmp");
mkdirSync(work, { recursive: true });
mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(work, "CLAUDE.md"), "# A folder for the cmux seat live check\n");
execFileSync("git", ["init", "-q"], { cwd: work });
const rolePrompt = join(root, "role.md");
writeFileSync(rolePrompt, "You are a build seat in a live check. Do only what you are asked.\n");
const mcpConfig = join(root, "mcp.json");
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });

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
const keys: string[] = [];
const cmux: Cmux = {
  ...real,
  sendKey: (ws, key, force) => {
    keys.push(key);
    return real.sendKey(ws, key, force);
  },
};
const name = `seat-live-check ${randomUUID().slice(0, 8)} · demo#1`;
const sessionId = randomUUID();
// a build seat's arguments, as `launch` in supervisor.ts builds them
const args = crewCliArgs({
  print: false,
  model: "haiku",
  mode: "writer",
  rolePromptFile: rolePrompt,
  sessionId,
  resume: false,
  area: [],
  sandbox: {
    cwd: work,
    gitCommonDir: join(work, ".git"),
    worktreeGitDir: join(work, ".git"),
    home: homedir(),
    dataDir: join(root, "data"),
    denyRead: [],
    pnpmStoreDir: join(root, "pnpm-store"),
    toolchainDirs: [nodeDir],
    tempRoot,
  },
  mcpConfigFile: mcpConfig,
  // no hub here to ask: a hook that allows every tool, in the seat's hook slot
  hook: { command: "true", timeoutS: 10 },
});
const env: Record<string, string> = {
  HOME: homedir(),
  ...CREW_CLI_ENV,
  TMPDIR: tempRoot,
  TMP: tempRoot,
  TEMP: tempRoot,
  CLAUDE_CODE_TMPDIR: tempRoot,
};
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
  log(`claude ${args.join(" ").slice(0, 400)}…`);
  const events: { kind: string; reason?: string }[] = [];
  const transcriptPath = join(root, "transcript.jsonl");
  session = startCmuxSession({
    cmux,
    name,
    cwd: work,
    command: "claude",
    args,
    env,
    claudeConfigDir: claudeConfigDir(process.env),
    dir: join(root, "run"),
    transcriptPath,
    cliSessionId: sessionId,
    messageDir: join(tempRoot, "mc-messages"),
    nodeDir,
    log: (m) => log(`session: ${m}`),
  });
  session.on((e) => {
    events.push(e);
    if (e.kind !== "output") log(`event ${JSON.stringify(e).slice(0, 160)}`);
  });
  await session.ready;
  check(session.alive, "the hub sees Claude up in the workspace");
  if (!session.alive) {
    const exit = events.find((e) => e.kind === "exit");
    log(`the start failed: ${exit?.reason ?? "no reason"}; the hub would go on under a keeper`);
  }
  log(`keys the hub sent before the start: ${keys.join(",") || "none"}`);
  if (session.alive) {
    const kept = (await real.agents()).some((a) => a.sessionId === sessionId);
    log(`cmux ${kept ? "keeps" : "keeps no"} record of the session (the hub does not need one)`);
    const transcript = () =>
      existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "";
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
    check(await until(() => results() >= 2, 120_000), "the turn with a refused tool ended");
    check(!existsSync(join(work, "made-by-live-check.txt")), "the refused tool did not run");
    log(
      `the hub ${transcript().includes(CMUX_TOOL_REFUSED_TEXT) ? "refused a permission dialog" : "met no permission dialog (the CLI refused the tool itself)"}`,
    );
    check(
      events.filter((e) => e.kind === "needs-input").length === 0,
      "the seat never showed as waiting on a person",
    );
  }
  await session.close();
  // cmux takes a moment to drop a closed workspace from its list
  let open = true;
  for (const s = Date.now(); open && Date.now() - s < 15_000; ) {
    open = (await real.workspaces()).some((w) => w.name === name);
    if (open) await new Promise((r) => setTimeout(r, 500));
  }
  check(!open, "the workspace is closed");
} finally {
  await tidy();
}
console.log(failures.length === 0 ? "\nPASS" : `\nFAIL: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
