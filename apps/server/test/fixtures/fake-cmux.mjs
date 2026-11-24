// A stand-in for the `cmux` command. Tests run it as `node fake-cmux.mjs --state <file> <command...>`.
// All its state lives in the JSON <file>, which a test reads and changes to play cmux and Claude:
//   workspaces  [{id, name, cwd, command}]      made by `new-workspace`
//   sessions    [{session_id, lifecycle, pid, workspace_id, transcript_path}]   what `sessions` prints
//   sent        [{ws, text, paste}]             every `send`
//   keys        [{ws, key, force}]              every `send-key`
//   closed      [ws]                            every `close-workspace`
//   screens     {ws: text}                      what `read-screen` prints
//   calls       [[argv...]]                     every call
// Switches a test sets: `down` (no socket until `open` is run), `denied` (access denied), `busy`
// (`send` refuses: a dialog is open), `noForce` (close-workspace refuses --force), `hideWorkspaces`
// (new-workspace makes none), `autoClaude` (new-workspace also starts a Claude: a session record for
// the id after `--session-id` / `--resume` in the launcher it was given, its pid `claudePid`, its
// transcript in `transcriptDir`).
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const stateAt = argv[argv.indexOf("--state") + 1];
let args = argv.slice(argv.indexOf("--state") + 2);
const read = () => JSON.parse(readFileSync(stateAt, "utf8"));
// Read-only commands write nothing back, so a test's own change to the file is never lost to them
// (they are polled every second). `calls` lists only the commands that change something.
const READ_ONLY = new Set(["sessions", "list-workspaces", "read-screen", "ping"]);
// written whole and renamed into place: a test reading the file never meets it half written
const save = (s) => {
  if (READ_ONLY.has(cmd)) return;
  const tmp = `${stateAt}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, stateAt);
};
const state = read();
state.calls ??= [];
state.calls.push(args);

// global options before the command
while (args[0]?.startsWith("--")) {
  args = args.slice(args[0] === "--json" ? 1 : 2);
}
const [cmd, ...rest] = args;
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (text, code = 1) => {
  save(state);
  process.stderr.write(`Error: ${text}\n`);
  process.exit(code);
};
const ok = (text = "") => {
  save(state);
  if (text !== "") process.stdout.write(`${text}\n`);
  process.exit(0);
};

if (cmd === "open") {
  state.down = false;
  ok();
}
if (state.down) fail("No live cmux socket found. Tried:\n  /tmp/cmux.sock");
if (state.denied && cmd !== "sessions") fail("Access denied");

switch (cmd) {
  case "ping":
    ok("PONG");
    break;
  case "new-workspace": {
    const ws = {
      id: randomUUID(),
      name: flag("--name"),
      cwd: flag("--cwd"),
      command: flag("--command"),
    };
    state.workspaces ??= [];
    if (!state.hideWorkspaces) state.workspaces.push(ws);
    if (state.autoClaude) {
      const script = readFileSync(
        ws.command.replace(/^'|'$/g, "").replaceAll("'\\''", "'"),
        "utf8",
      );
      const m = script.match(/'--(?:session-id|resume)' '([^']+)'/);
      if (m) {
        state.sessions ??= [];
        const dir = state.transcriptDir ?? "/tmp";
        state.sessions.push({
          session_id: m[1],
          lifecycle: "idle",
          pid: state.claudePid ?? process.ppid,
          workspace_id: ws.id,
          transcript_path: join(dir, `${m[1]}.jsonl`),
        });
      }
    }
    ok("OK workspace:1");
    break;
  }
  case "list-workspaces":
    ok(
      JSON.stringify({
        workspaces: (state.workspaces ?? []).map((w) => ({ id: w.id, title: w.name })),
      }),
    );
    break;
  case "sessions":
    ok(JSON.stringify({ sessions: state.sessions ?? [] }));
    break;
  case "send": {
    if (state.busy) fail("a question dialog is open; nothing sent");
    const text = rest.at(-1);
    state.sent ??= [];
    state.sent.push({ ws: flag("--workspace"), text, paste: rest.includes("--paste") });
    ok();
    break;
  }
  case "send-key":
    state.keys ??= [];
    state.keys.push({ ws: flag("--workspace"), key: rest.at(-1), force: rest.includes("--force") });
    ok();
    break;
  case "read-screen":
    ok(state.screens?.[flag("--workspace")] ?? state.screen ?? "");
    break;
  case "close-workspace": {
    if (state.noForce && rest.includes("--force")) fail("unknown flag --force");
    const id = flag("--workspace");
    state.closed ??= [];
    state.closed.push(id);
    state.workspaces = (state.workspaces ?? []).filter((w) => w.id !== id);
    state.sessions = (state.sessions ?? []).filter((r) => r.workspace_id !== id);
    ok();
    break;
  }
  default:
    fail(`unknown command ${cmd}`);
}
