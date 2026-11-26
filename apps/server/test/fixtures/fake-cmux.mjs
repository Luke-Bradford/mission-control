// A stand-in for the `cmux` command. Tests run it as `node fake-cmux.mjs --state <file> <command...>`.
// All its state lives in the JSON <file>, which a test reads and changes to play cmux and Claude:
//   workspaces  [{id, name, cwd, command, window}]  made by `new-workspace`; `window` defaults to the
//                                               current one, CURRENT_WINDOW
//   sessions    [{session_id, lifecycle, pid, workspace_id, transcript_path}]   kept here; `sessions` prints `lifecycle` as real cmux does, under `agent_lifecycle`
//   sent        [{ws, text, paste}]             every `send`
//   keys        [{ws, key, force}]              every `send-key`
//   closed      [ws]                            every `close-workspace`
//   screens     {ws: text}                      what `read-screen` prints
//   calls       [[argv...]]                     every call that changes something
//   statuses    {ws: {key: value}}              what `list-status` prints, one `key=value` a line
//   selected    [ws]                            every `select-workspace`
//   inbox       [{workspace_id, text, state}]   what `agent inbox` prints, in real cmux's shape
//                                               (`recipient_workspace_id`, `body`, `state`, `read_at`)
//   messages    [{to, from, text}]              every `agent message`
//   panes       [{ws, type, url}]               every `new-pane`
// Every call, read-only ones included, is also appended to `<file>.log`, one JSON argv a line.
// `list-workspaces` names only one window's workspaces, as real cmux does: the current one, or the
// one after `--window`. `list-windows` names every window a workspace is in, the current one first.
// `workspaces` rows may carry `cwd`, and `sessions` rows `cwd`: both are printed as given.
// Switches a test sets: `down` (no socket until `open` is run), `denied` (access denied), `busy`
// (`send` refuses: a dialog is open), `noForce` (close-workspace refuses --force), `hideWorkspaces`
// (new-workspace makes none), `autoClaude` (new-workspace also starts a Claude: a session record for
// the id after `--session-id` / `--resume` in the launcher it was given, its pid `claudePid`, its
// transcript in `transcriptDir`).
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CURRENT_WINDOW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const argv = process.argv.slice(2);
const stateAt = argv[argv.indexOf("--state") + 1];
let args = argv.slice(argv.indexOf("--state") + 2);
const read = () => JSON.parse(readFileSync(stateAt, "utf8"));
// Read-only commands write nothing back, so a test's own change to the file is never lost to them
// (they are polled every second). `calls` lists only the commands that change something.
const READ_ONLY = new Set([
  "sessions",
  "list-workspaces",
  "read-screen",
  "ping",
  "list-status",
  "list-windows",
  "agent inbox",
  "workspace-group list",
]);
// written whole and renamed into place: a test reading the file never meets it half written
const save = (s) => {
  if (READ_ONLY.has(cmd) || READ_ONLY.has(`${cmd} ${rest[0]}`)) return;
  const tmp = `${stateAt}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, stateAt);
};
const state = read();
state.calls ??= [];
state.calls.push(args);
appendFileSync(`${stateAt}.log`, `${JSON.stringify(args)}\n`);

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
  case "workspace-group": {
    const [sub, ...more] = rest;
    if (sub === "list") ok(JSON.stringify({ groups: state.groups ?? [] }));
    if (sub === "create") {
      state.groups ??= [];
      const externalId = more[more.indexOf("--external-id") + 1];
      state.groups.push({
        id: externalId,
        external_id: externalId,
        name: more[more.indexOf("--name") + 1],
        workspace_ids: [],
      });
      ok("OK");
    }
    if (sub === "add") {
      const group = more[more.indexOf("--group") + 1];
      const workspace = more[more.indexOf("--workspace") + 1];
      const row = (state.groups ?? []).find((candidate) => candidate.id === group);
      if (!row) fail("unknown group");
      row.workspace_ids ??= [];
      if (!row.workspace_ids.includes(workspace)) row.workspace_ids.push(workspace);
      ok("OK");
    }
    if (["pin", "set-color", "set-icon"].includes(sub)) ok("OK");
    fail(`unknown workspace-group command ${sub}`);
    break;
  }
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
    // Seat workspaces start a shell and become Claude launchers only when a run begins. The
    // per-run driver passes its generated launcher as a quoted path; do not try to read `zsh`.
    if (state.autoClaude && ws.command.startsWith("'")) {
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
  case "list-windows": {
    const ids = new Set([
      CURRENT_WINDOW,
      ...(state.workspaces ?? []).map((w) => w.window ?? CURRENT_WINDOW),
    ]);
    ok(JSON.stringify({ windows: [...ids].map((id, index) => ({ id, index })) }));
    break;
  }
  case "list-workspaces": {
    const window = flag("--window") ?? CURRENT_WINDOW;
    ok(
      JSON.stringify({
        window_id: window,
        workspaces: (state.workspaces ?? [])
          .filter((w) => (w.window ?? CURRENT_WINDOW) === window)
          .map((w) => ({
            id: w.id,
            title: w.name,
            ...(w.cwd ? { cwd: w.cwd } : {}),
          })),
      }),
    );
    break;
  }
  case "sessions":
    // the shape real cmux prints (0.65.2): the state is `agent_lifecycle`, with `runtime_status` beside it
    ok(
      JSON.stringify({
        sessions: (state.sessions ?? []).map(({ lifecycle, ...r }) => ({
          ...r,
          agent: "claude",
          agent_lifecycle: lifecycle,
          // real cmux does not mirror the two: a record can be needsInput here and idle there
          runtime_status: "idle",
        })),
      }),
    );
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
  case "read-screen": {
    const screen = state.screens?.[flag("--workspace")] ?? state.screen ?? "";
    const lines = flag("--lines");
    ok(lines === undefined ? screen : screen.split("\n").slice(-Number(lines)).join("\n"));
    break;
  }
  case "select-workspace":
    state.selected ??= [];
    state.selected.push(flag("--workspace"));
    ok("OK");
    break;
  case "list-status": {
    const entries = Object.entries(state.statuses?.[flag("--workspace")] ?? {});
    ok(entries.map(([k, v]) => `${k}=${v}`).join("\n"));
    break;
  }
  case "set-status": {
    const ws = flag("--workspace");
    state.statuses ??= {};
    state.statuses[ws] ??= {};
    state.statuses[ws][rest[0]] = rest[1];
    ok();
    break;
  }
  case "clear-status": {
    const ws = flag("--workspace");
    delete state.statuses?.[ws]?.[rest[0]];
    ok();
    break;
  }
  case "pr": {
    const ws = flag("--workspace");
    state.prs ??= {};
    if (rest[0] === "clear") delete state.prs[ws];
    else state.prs[ws] = rest[0];
    ok();
    break;
  }
  case "notify": {
    state.notifications ??= [];
    state.notifications.push({
      ws: flag("--workspace"),
      title: flag("--title"),
      body: flag("--body"),
    });
    ok();
    break;
  }
  case "agent": {
    const [sub, ...more] = rest;
    if (sub === "inbox")
      ok(
        JSON.stringify({
          messages: (state.inbox ?? []).map((m, i) => ({
            id: `m${i}`,
            recipient_workspace_id: m.workspace_id,
            body: m.text,
            state: m.state,
            read_at: m.state === "read" ? "2026-11-25T10:00:00Z" : null,
          })),
        }),
      );
    if (sub === "message") {
      const from = more[more.indexOf("--from") + 1];
      state.messages ??= [];
      state.messages.push({ to: more[0], from, text: more.at(-1) });
      ok("OK");
    }
    fail(`unknown agent command ${sub}`);
    break;
  }
  case "new-pane":
    state.panes ??= [];
    state.panes.push({ ws: flag("--workspace"), type: flag("--type"), url: flag("--url") });
    ok("OK surface:9");
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
