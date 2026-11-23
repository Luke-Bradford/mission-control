// Stands in for `open -a cmux`: brings the fake cmux back up by clearing its failure flags.
// With `restore`, cmux also restores the saved agent with a new pid, as a relaunch does.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [statePath, mode] = process.argv.slice(2);
// the same lock fake-cmux.mjs takes around each read-modify-write
const lockPath = `${statePath}.lock`;
for (;;) {
  try {
    mkdirSync(lockPath);
    break;
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
try {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.ping = undefined;
  state.sessions_fail = false;
  state.send_fail = false;
  state.close_fail = false;
  if (mode === "restore") for (const session of state.sessions) session.pid = 2;
  writeFileSync(statePath, JSON.stringify(state));
} finally {
  rmSync(lockPath, { recursive: true, force: true });
}
