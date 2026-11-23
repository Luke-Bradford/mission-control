// Minimal cmux CLI fixture. State lives in the first argument so each test owns its workspaces.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

const [statePath, ...rest] = process.argv.slice(2);
// the global `--id-format <fmt>` flag comes before the command
if (rest[0] === "--id-format") rest.splice(0, 2);
const [command, ...args] = rest;
// Several runs poll at once: take a lock around each read-modify-write so no call is lost.
const lockPath = `${statePath}.lock`;
for (;;) {
  try {
    mkdirSync(lockPath);
    break;
  } catch (error) {
    // A state folder that is gone means the test ended: stop instead of waiting for a lock.
    if (error?.code !== "EEXIST") process.exit(1);
    // A lock older than a second belongs to a call that was killed: take it over.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 1000)
        rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
process.on("exit", () => rmSync(lockPath, { recursive: true, force: true }));
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { sessions: [], calls: [] };
const save = () => {
  writeFileSync(`${statePath}.tmp${process.pid}`, JSON.stringify(state));
  renameSync(`${statePath}.tmp${process.pid}`, statePath);
};
state.calls.push([command, ...args]);
if (command === "ping") {
  save();
  if (state.ping === "denied") {
    process.stderr.write("Error: Access denied\n");
    process.exit(1);
  }
  process.exit(0);
}
// A state with `short: true` answers like cmux 0.65: a short reference, UUIDs only in the list.
// `list_hidden` lists hide the newest workspace for that many calls (a delayed listing).
if (command === "list-workspaces") {
  for (const session of state.sessions)
    if ((session.list_hidden ?? 0) > 0) session.list_hidden -= 1;
    else process.stdout.write(`  workspace:${session.n} ${session.workspace_id}  ${session.name}\n`);
  save();
  process.exit(0);
}
if (command === "new-workspace") {
  const at = (flag) => args[args.indexOf(flag) + 1];
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  state.sessions.push({
    workspace_id: workspaceId,
    session_id: sessionId,
    agent_lifecycle: "idle",
    pid: 1,
    transcript_path: null,
    name: at("--name"),
    cwd: at("--cwd"),
    command: at("--command"),
    session_calls: 0,
    n: state.sessions.length + 1,
    list_hidden: state.list_hidden ?? 0,
  });
  save();
  process.stdout.write(state.short ? `OK workspace:${state.sessions.length}\n` : `${workspaceId}\n`);
  process.exit(0);
}
if (command === "sessions") {
  for (const session of state.sessions) session.session_calls = (session.session_calls ?? 0) + 1;
  save();
  process.stdout.write(
    JSON.stringify({ sessions: state.sessions.filter((session) => session.session_calls > 1) }),
  );
  process.exit(0);
}
if (command === "send" || command === "send-key" || command === "read-screen") {
  save();
  process.exit(0);
}
if (command === "close-workspace") {
  state.sessions = state.sessions.filter(
    (s) => s.workspace_id !== args[args.indexOf("--workspace") + 1],
  );
  save();
  process.exit(0);
}
save();
