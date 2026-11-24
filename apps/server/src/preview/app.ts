/**
 * A preview of another repo's app: its PR head checked out in a worktree of the repo's own crew
 * clone and started with the repo's configured `run_command`, told its port in `PORT`. The hub's
 * own repo is built differently (it runs the hub from the worktree); see `main.ts`.
 */
import { join } from "node:path";

export interface AppPreviewDeps {
  /** Runs a command to its end (git); rejects when it fails. */
  run(command: string, args: string[], cwd: string | undefined, signal: AbortSignal): Promise<void>;
  /** Starts the repo's run command in `cwd` with `env` added; resolves to the live child. */
  spawnApp(command: string, cwd: string, env: Record<string, string>, signal: AbortSignal): Child;
  /** Resolves once the child answers on its port; rejects if it stops first or the signal aborts. */
  wait(child: Child, port: number, signal: AbortSignal): Promise<void>;
  stop(child: Child): Promise<void>;
}

/** A started process, opaque to this module. */
export type Child = object;

export interface AppPreviewInput {
  /** The repo's crew clone. */
  checkout: string;
  /** A private folder for this preview; the worktree is made inside it. */
  root: string;
  pr: number;
  sha?: string;
  runCommand: string | undefined;
  port: number;
  signal: AbortSignal;
}

/** Where the preview's worktree and fetched ref live, for the caller's cleanup. */
export const appPreviewPaths = (root: string, pr: number) => ({
  worktree: join(root, "worktree"),
  ref: `refs/mc-preview/${pr}`,
});

/** Checks out the PR head, runs the repo's own command on `port` and waits for it to answer. */
export async function startAppPreview(
  deps: AppPreviewDeps,
  input: AppPreviewInput,
): Promise<{ stop(): Promise<void> }> {
  if (input.runCommand === undefined || input.runCommand.trim() === "")
    throw new Error("the repo has no run_command to start its app for a preview");
  const { worktree, ref } = appPreviewPaths(input.root, input.pr);
  await deps.run(
    "git",
    ["-C", input.checkout, "fetch", "origin", `+pull/${input.pr}/head:${ref}`],
    undefined,
    input.signal,
  );
  await deps.run(
    "git",
    ["-C", input.checkout, "worktree", "add", "-f", "--detach", worktree, input.sha ?? ref],
    undefined,
    input.signal,
  );
  const child = deps.spawnApp(
    input.runCommand,
    worktree,
    { PORT: String(input.port) },
    input.signal,
  );
  try {
    await deps.wait(child, input.port, input.signal);
  } catch (e) {
    await deps.stop(child).catch(() => {});
    throw e;
  }
  return { stop: () => deps.stop(child) };
}
