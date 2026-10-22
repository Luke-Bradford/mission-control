/**
 * The one way the hub runs `gh` for the crew (draft_pr). No shell; an environment of `PATH` and
 * `HOME` only, so nothing of the server's own environment reaches it; no prompts; a timeout. The
 * answer is the exit code and both streams: a failure is the caller's to word, never thrown.
 */
import { execFile } from "node:child_process";
import { CREW_GIT_SLOW_MS } from "../runtime/checkouts.ts";

export interface GhResult {
  /** The exit code; null when gh was killed at its timeout or could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GhOptions {
  cwd: string;
  /** Added after PATH and HOME; `GH_PROMPT_DISABLED=1` is always set last. */
  env?: NodeJS.ProcessEnv;
  /** Default `CREW_GIT_SLOW_MS`. */
  timeoutMs?: number;
  /** Default 1 MiB; a CI log read asks for more. */
  maxBuffer?: number;
}

export type GhRunner = (args: string[], opts: GhOptions) => Promise<GhResult>;

/** gh's own output cap: a PR URL, or a short JSON list. */
const GH_MAX_BUFFER = 1024 * 1024;

/** A runner for `command` (default `gh` on PATH). */
export function createGh(command = "gh"): GhRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? CREW_GIT_SLOW_MS,
          maxBuffer: opts.maxBuffer ?? GH_MAX_BUFFER,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...opts.env,
            GH_PROMPT_DISABLED: "1",
          },
        },
        (err, stdout, stderr) => {
          const code =
            err === null
              ? 0
              : typeof (err as { code?: unknown }).code === "number"
                ? err.code
                : null;
          resolve({ code: code as number | null, stdout, stderr });
        },
      );
    });
}

/**
 * The gh binary: `MC_GH_COMMAND` only on a preview started with `MC_CREW=1` (a fake gh for a crew
 * trial); anywhere else it is ignored, and `log` is told once (this runs once, at startup).
 */
export function ghCommand(
  env: NodeJS.ProcessEnv,
  preview: boolean,
  log: (line: string) => void,
): string {
  const asked = env.MC_GH_COMMAND;
  if (asked === undefined || asked === "") return "gh";
  if (preview && env.MC_CREW === "1") return asked;
  log("MC_GH_COMMAND is ignored: only a preview started with MC_CREW=1 honours it");
  return "gh";
}
