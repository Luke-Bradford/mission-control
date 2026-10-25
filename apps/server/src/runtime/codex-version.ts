import { execFile } from "node:child_process";
import { CODEX_COMMAND, CODEX_MIN_VERSION } from "@mc/core";
import { codexVersionAllowed } from "./codex-floor.ts";

const VERSION_TIMEOUT_MS = 2000;

/** Probe without blocking other seats' streams or approvals; kill an unresponsive binary. */
export function probeCodexVersion(command = CODEX_COMMAND): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["--version"],
      {
        encoding: "utf8",
        timeout: VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error || !codexVersionAllowed(stdout)) {
          reject(new Error(`Codex requires ${CODEX_MIN_VERSION} or newer`));
        } else resolve(stdout.trim().slice("codex-cli ".length));
      },
    ).stdin?.end();
  });
}
