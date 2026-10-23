/**
 * The keeper's entry: `<crew.node> --experimental-strip-types keeper-cli.ts <run folder>`, started
 * detached by the hub's session driver. It runs the keeper until the CLI has exited, then exits 0.
 * A SIGTERM (`endKeeper`, or an operator) ends the CLI and so the keeper; a hangup is ignored.
 */
import { runKeeper } from "./keeper.ts";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("usage: keeper-cli <run folder>\n");
  process.exit(2);
}
process.on("SIGHUP", () => {});
process.on("uncaughtException", (e) => {
  process.stderr.write(`keeper failed: ${e.stack ?? e.message}\n`);
  process.exit(1);
});
const keeper = runKeeper(dir);
process.on("SIGTERM", keeper.terminate);
process.on("SIGINT", keeper.terminate);
void keeper.done.then(() => process.exit(0));
