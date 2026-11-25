// A check for the session-checks tests: `node check-span.mjs <log>` appends `start <ms>` to <log>,
// waits 300 ms, then appends `end <ms>`, so a test can see whether two checks overlapped.
import { appendFileSync } from "node:fs";

const log = process.argv[2];
appendFileSync(log, `start ${Date.now()} ${process.cwd()}\n`);
setTimeout(() => appendFileSync(log, `end ${Date.now()} ${process.cwd()}\n`), 300);
