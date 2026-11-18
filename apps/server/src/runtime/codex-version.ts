import { execFile } from "node:child_process";
import { CODEX_COMMAND, CODEX_MIN_VERSION } from "@mc/core";
import { codexVersionAllowed } from "./codex-floor.ts";

/** First try, then one retry with longer: a busy machine can stall the probe, not the CLI. */
export const CODEX_VERSION_TIMEOUTS_MS: readonly number[] = [2000, 10_000];

type Attempt = { ok: string } | { retry: Error } | { refuse: Error };

/** One probe without blocking other seats' streams or approvals; kill an unresponsive binary. */
function attempt(command: string, timeout: number): Promise<Attempt> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["--version"],
      { encoding: "utf8", timeout, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) {
          resolve({
            retry: new Error(
              error.killed
                ? "Codex version check timed out"
                : `Codex could not be run: ${error.message}`,
            ),
          });
        } else if (!codexVersionAllowed(stdout)) {
          const found = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(stdout.trim())?.[1];
          resolve({
            refuse: new Error(
              found === undefined
                ? `Codex version output was not readable (needs ${CODEX_MIN_VERSION} or newer)`
                : `Codex ${found} is older than ${CODEX_MIN_VERSION}`,
            ),
          });
        } else resolve({ ok: stdout.trim().slice("codex-cli ".length) });
      },
    ).stdin?.end();
  });
}

/** The CLI version; a timeout or failure to run is retried before the start is refused. */
export async function probeCodexVersion(
  command = CODEX_COMMAND,
  timeouts: readonly number[] = CODEX_VERSION_TIMEOUTS_MS,
): Promise<string> {
  let last = new Error("Codex version check timed out");
  for (const timeout of timeouts) {
    const result = await attempt(command, timeout);
    if ("ok" in result) return result.ok;
    if ("refuse" in result) throw result.refuse;
    last = result.retry;
  }
  throw last;
}
