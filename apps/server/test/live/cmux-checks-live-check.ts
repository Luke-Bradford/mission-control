/**
 * The controller's live check for a cmux session's repo checks, on this Mac:
 *   node --experimental-strip-types apps/server/test/live/cmux-checks-live-check.ts <repo> [<workspace id>] [-- <command>...]
 * Runs <repo>'s checks (its Mission Control block at origin/HEAD, else the commands after `--`,
 * set as the page's list) the way the hub does: at low
 * priority, as one operator-asked run. It samples the 1-minute load every 2 s and exits 1 if the
 * peak reaches the core count. Given a cmux workspace id, it also sends that session one 40-line
 * `cmux agent message` and prints what cmux answered, so the controller can see how it arrives.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkoutOf,
  createSessionChecks,
  failureMessage,
  lowPriorityPrefix,
} from "../../src/sessions/checks.ts";
import { Store } from "../../src/store.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const args = process.argv.slice(2);
const dash = args.indexOf("--");
const positional = dash < 0 ? args : args.slice(0, dash);
const commands = dash < 0 ? [] : args.slice(dash + 1);
const repo = resolve(positional[0] ?? ".");
const workspace = positional[1];
const dir = mkdtempSync(join(tmpdir(), "mc-checks-live-"));
const store = new Store(join(dir, "store.sqlite"));
const cores = availableParallelism();
const prefix = lowPriorityPrefix(process.platform);
console.log(`repo ${repo}; ${cores} cores; prefix ${prefix.join(" ")}`);

const sent: string[] = [];
const checks = createSessionChecks({
  cmux: {
    ping: async () => "up",
    workspaces: async () => [{ id: WS, name: "live check", cwd: repo }],
    agents: async () => [],
    agentMessage: async (_ws, text) => {
      sent.push(text);
    },
  },
  store,
  seatIds: () => [],
  crewRoots: () => [],
  configuredChecks: () => [],
  notify: (text) => console.log(`notice: ${text}`),
  log: (m) => console.log(m),
});

let peak = loadavg()[0] ?? 0;
const sampler = setInterval(() => {
  const now = loadavg()[0] ?? 0;
  peak = Math.max(peak, now);
  const c = checks.checkOf(WS);
  console.log(`load ${now.toFixed(2)} · ${c?.state ?? "-"} ${c?.command ?? ""}`);
}, 2000);

if (commands.length > 0) {
  const main = (await checkoutOf(repo))?.main ?? repo;
  await checks.repos([{ repoKey: main }]);
  checks.setRepo(main, { commands }, "live check");
}
const outcome = await checks.run(WS);
console.log(`run: ${outcome}`);
if (outcome === "queued") {
  for (;;) {
    await checks.tick();
    const state = checks.checkOf(WS)?.state;
    if (state !== "queued" && state !== "running") break;
    await new Promise((r) => setTimeout(r, 500));
  }
}
clearInterval(sampler);
console.log(
  `result: ${JSON.stringify(checks.checkOf(WS))}; peak load ${peak.toFixed(2)} of ${cores}`,
);
for (const text of sent) console.log(`message for the session:\n${text}`);
await checks.stop();
store.close();
rmSync(dir, { recursive: true, force: true });

if (workspace !== undefined) {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${"x".repeat(60)}`).join("\n");
  const text = failureMessage(
    "Mission Control ran this repo's checks after your last piece of work. `live check` failed with exit code 2.",
    lines,
  );
  try {
    const out = execFileSync(
      "cmux",
      ["agent", "message", workspace, "--from", "Mission Control", text],
      { encoding: "utf8" },
    );
    console.log(`cmux took a ${text.length}-character message: ${out.trim()}`);
  } catch (e) {
    console.log(`cmux refused a ${text.length}-character message: ${String(e)}`);
  }
}

if (peak >= cores) {
  console.log("FAIL: load reached the core count during the check");
  process.exit(1);
}
console.log("OK: load stayed below the core count");
