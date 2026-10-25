import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MapChange } from "@mc/core";
import { type GitExec, mapChanges, realGitExec } from "../files.ts";

// One git process at a time, leaving the other map slot for conflict checks.
let pending: Promise<unknown> = Promise.resolve();
const git: GitExec = (args) => {
  const next = pending.then(() => realGitExec(args));
  pending = next.catch(() => {});
  return next;
};

/** Cached per checkout; transcript activity invalidates even when HEAD and index stay still. */
export class SeatDiff {
  private revision = "";
  private due = 0;
  private key: string | null = null;
  private running = false;
  private value: MapChange[] | null = null;

  changes(): MapChange[] | null {
    return this.value === null ? null : structuredClone(this.value);
  }

  poll(cwd: string, revision: string): void {
    if (revision !== this.revision) {
      this.revision = revision;
      // Bound the debounce even under a continuous burst of edits.
      if (!this.due) this.due = Date.now() + 2000;
    }
    if (this.running) return;
    this.running = true;
    this.read(cwd).finally(() => {
      this.running = false;
    });
  }

  private async read(cwd: string): Promise<void> {
    try {
      const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd];
      const head = await git([...args, "rev-parse", "HEAD", "origin/HEAD"]);
      const index = (await git([...args, "rev-parse", "--git-path", "index"])).trim();
      const st = await stat(isAbsolute(index) ? index : join(cwd, index));
      const key = `${cwd}:${head}:${st.mtimeMs}:${st.size}`;
      if (this.key === key && (!this.due || Date.now() < this.due)) return;
      if (this.due && Date.now() < this.due) return;
      const revision = this.revision;
      this.value = await mapChanges(cwd, git);
      this.key = key;
      if (this.revision === revision) this.due = 0;
    } catch {
      // Unavailable bases, binary counts and filters must never become invented zeroes.
      this.value = null;
      this.key = null;
    }
  }
}
