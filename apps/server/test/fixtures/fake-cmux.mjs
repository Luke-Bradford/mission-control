// Minimal cmux CLI fixture. State lives in the first argument so each test owns its workspaces.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [statePath, command, ...args] = process.argv.slice(2);
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { sessions: [], calls: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
state.calls.push([command, ...args]);
if (command === "ping") process.exit(0);
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
  });
  save();
  process.stdout.write(`${workspaceId}\n`);
  process.exit(0);
}
if (command === "sessions") {
  save();
  process.stdout.write(JSON.stringify({ sessions: state.sessions }));
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
