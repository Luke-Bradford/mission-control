// A stand-in for a keeper of an older protocol, as a hub that was updated would find one still
// running. Tests run it detached as `node old-keeper.mjs <run folder> <command> [args...]`: it
// writes `keeper.pid` and `cli.pid` as the real keeper does, runs the command with its stdin held
// open, listens on `<run folder>/s` and answers every connection with `{"t":"hello","version":0}`.
// On SIGTERM it kills the command and exits, which is how `endKeeper` ends it.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const [dir, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
child.stdin.on("error", () => {});
writeFileSync(join(dir, "cli.pid"), `${child.pid}\n`, { mode: 0o600 });
writeFileSync(join(dir, "keeper.pid"), `${process.pid}\n`, { mode: 0o600 });

const server = createServer((sock) => {
  sock.on("error", () => {});
  sock.write(`${JSON.stringify({ t: "hello", version: 0 })}\n`);
});
server.listen(join(dir, "s"));

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  server.close();
  process.exit(0);
});
child.on("exit", () => process.exit(0));
