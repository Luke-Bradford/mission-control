// Minimal cmux CLI fixture. State lives in the first argument so each test owns its workspaces.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
// `send_fail` / `sessions_fail` / `close_fail` make those commands fail, as a cmux that has stopped answering does.
if (
  (command === "send" && state.send_fail) ||
  (command === "sessions" && state.sessions_fail) ||
  (command === "close-workspace" && state.close_fail)
) {
  process.stderr.write("Error: cmux is not answering\n");
  process.exit(1);
}
if (command === "ping") {
  save();
  if (state.ping === "denied") {
    process.stderr.write("Error: Access denied\n");
    process.exit(1);
  }
  if (state.ping === "down") {
    process.stderr.write("Error: connection refused\n");
    process.exit(1);
  }
  process.exit(0);
}
// A state with `short: true` answers like cmux 0.65: a short reference, UUIDs only in the list.
// `list_hidden` lists hide the newest workspace for that many calls (a delayed listing).
if (command === "list-workspaces") {
  for (const session of state.sessions)
    if ((session.list_hidden ?? 0) > 0) session.list_hidden -= 1;
    else
      process.stdout.write(`  workspace:${session.n} ${session.workspace_id}  ${session.name}\n`);
  save();
  process.exit(0);
}
if (command === "new-workspace") {
  const at = (flag) => args[args.indexOf(flag) + 1];
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  // With `bridge`, the launcher really runs under zsh: the CLI it execs reads its stdin from a
  // file that `send` appends to and writes its stream-json stdout to the transcript, as Claude does.
  const run = state.bridge && existsSync("/bin/zsh");
  const dir = `${statePath}.ws-${workspaceId}`;
  const pidFile = `${dir}/pid`;
  const inFile = `${dir}/in.jsonl`;
  const outFile = `${statePath}.transcript-${workspaceId}.jsonl`;
  let pgid = null;
  if (run) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(inFile, "");
    writeFileSync(outFile, "");
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'tail -f -n +1 "$1" | /bin/sh -c \'echo $$ > "$1"; exec /bin/zsh "$2"\' sh "$2" "$3" > "$4"',
        "sh",
        inFile,
        pidFile,
        at("--command"),
        outFile,
      ],
      { detached: true, stdio: "ignore", cwd: at("--cwd") },
    );
    child.unref();
    pgid = child.pid;
    // a test that ends without closing the workspace leaves nothing running
    spawn("/bin/sh", ["-c", 'sleep 150; kill -TERM -- -"$1" 2>/dev/null', "sh", String(pgid)], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  state.sessions.push({
    workspace_id: workspaceId,
    session_id: sessionId,
    agent_lifecycle: "idle",
    pid: run ? null : 1,
    transcript_path: state.bridge ? outFile : null,
    ...(run ? { run: true, pgid, pid_file: pidFile, in_file: inFile, sends: 0 } : {}),
    name: at("--name"),
    cwd: at("--cwd"),
    command: at("--command"),
    session_calls: 0,
    n: state.sessions.length + 1,
    list_hidden: state.list_hidden ?? 0,
  });
  save();
  process.stdout.write(
    state.short ? `OK workspace:${state.sessions.length}\n` : `${workspaceId}\n`,
  );
  process.exit(0);
}
if (command === "sessions") {
  for (const session of state.sessions) {
    session.session_calls = (session.session_calls ?? 0) + 1;
    if (session.run) {
      // the launcher's process registers once it runs; it is running until every message has a result
      if (session.pid === null && existsSync(session.pid_file)) {
        const pid = Number(readFileSync(session.pid_file, "utf8").trim());
        if (pid > 0) session.pid = pid;
      }
      const results =
        readFileSync(session.transcript_path, "utf8").match(/"type":"result"/g)?.length ?? 0;
      session.agent_lifecycle = results >= session.sends ? "idle" : "running";
    }
  }
  save();
  process.stdout.write(
    JSON.stringify({
      sessions: state.sessions.filter(
        (session) => session.session_calls > 1 && (!session.run || session.pid !== null),
      ),
    }),
  );
  process.exit(0);
}
if (command === "send" && state.bridge) {
  // Delivers the text the way the terminal would: Claude reads the brief file it points at.
  const text = args.at(-1) ?? "";
  const file = /^Mission Control sent you a message\. Read (.+) and act on it\.$/.exec(text)?.[1];
  const brief = file ? readFileSync(file, "utf8") : text;
  const session = state.sessions.find(
    (s) => s.workspace_id === args[args.indexOf("--workspace") + 1],
  );
  if (session?.run) {
    appendFileSync(
      session.in_file,
      `${JSON.stringify({ type: "user", message: { role: "user", content: brief } })}\n`,
    );
    session.sends += 1;
    session.agent_lifecycle = "running";
  }
  save();
  process.exit(0);
}
if (command === "send" || command === "send-key" || command === "read-screen") {
  save();
  process.exit(0);
}
if (command === "close-workspace") {
  for (const session of state.sessions)
    if (session.pgid && session.workspace_id === args[args.indexOf("--workspace") + 1])
      try {
        process.kill(-session.pgid, "SIGTERM");
      } catch {}
  state.sessions = state.sessions.filter(
    (s) => s.workspace_id !== args[args.indexOf("--workspace") + 1],
  );
  save();
  process.exit(0);
}
save();
