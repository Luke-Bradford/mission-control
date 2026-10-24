import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = JSON.parse(process.env.FAKE_MODELS_SCENARIO);
const home = process.env.CODEX_HOME;
const record = (value) =>
  appendFileSync(process.env.FAKE_MODELS_RECORD, `${JSON.stringify(value)}\n`);
record({
  pid: process.pid,
  home: realpathSync(home),
  cwd: process.cwd(),
  auth: readFileSync(join(home, "auth.json"), "utf8"),
  mode: statSync(join(home, "auth.json")).mode & 0o777,
  config: readFileSync(join(home, "config.toml"), "utf8"),
});
if (scenario.inheritedStdout) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "ignore"],
  });
  record({ descendant: child.pid });
  if (scenario.exitParent) process.exit(0);
}
let page = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  if (scenario.hang) return;
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  } else if (message.method === "model/list") {
    const response = scenario.error
      ? { error: { code: -1, message: "fake credential must not appear in errors" } }
      : { result: scenario.pages[page++] };
    process.stdout.write(`${JSON.stringify({ id: message.id, ...response })}\n`);
  }
});
