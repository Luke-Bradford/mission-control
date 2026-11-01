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
  constructor(privateChanged?: () => void) {
    this.changed = privateChanged;
  }
  private changed: (() => void) | undefined;
  private revision = "";
  private due = 0;
  private key: string | null = null;
  private running = false;
  private value: MapChange[] | null = null;
  private onBranch: string | null = null;
  private others: string[] | null = null;
  private count = 0;

  /** How many reads have landed: a cache over `changes` is stale once this moves. */
  reads(): number {
    return this.count;
  }

  changes(): MapChange[] | null {
    return this.value === null ? null : structuredClone(this.value);
  }

  /**
   * The branch the worktree had checked out when the diff was read (null when detached or
   * unread): a seat's worktree can move on to a later run's branch, and the diff is that branch's.
   */
  branch(): string | null {
    return this.value === null ? null : this.onBranch;
  }

  /**
   * Files in the worktree git doesn't track and doesn't ignore, read with the diff (null when
   * unread): the only files whose edit churn can stand for a change the diff can't see yet.
   */
  untracked(): string[] | null {
    return this.value === null || this.others === null ? null : [...this.others];
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
      // HEAD, origin/HEAD and the checked-out branch in one process; a branch switch at the same
      // commit changes the key too
      const head = await git([...args, "rev-parse", "HEAD", "origin/HEAD", "--abbrev-ref", "HEAD"]);
      const index = (await git([...args, "rev-parse", "--git-path", "index"])).trim();
      const st = await stat(isAbsolute(index) ? index : join(cwd, index));
      const key = `${cwd}:${head}:${st.mtimeMs}:${st.size}`;
      if (this.key === key && (!this.due || Date.now() < this.due)) return;
      if (this.due && Date.now() < this.due) return;
      const revision = this.revision;
      const branch = head.trim().split("\n").at(-1)?.trim() ?? "";
      const value = await mapChanges(cwd, git);
      let others: string[] | null;
      try {
        others = (await git([...args, "ls-files", "--others", "--exclude-standard", "-z"]))
          .split("\0")
          .filter(Boolean);
      } catch {
        others = null; // unknown: no churn stands in for the diff
      }
      const changed =
        JSON.stringify([this.value, this.onBranch, this.others]) !==
        JSON.stringify([value, branch && branch !== "HEAD" ? branch : null, others]);
      // Publish together: a reader between awaits must never see a diff without its untracked files.
      this.value = value;
      this.onBranch = branch && branch !== "HEAD" ? branch : null;
      this.others = others;
      this.key = key;
      this.count++;
      if (changed) this.changed?.();
      if (this.revision === revision) this.due = 0;
    } catch {
      const changed = this.value !== null || this.onBranch !== null || this.others !== null;
      // Unavailable bases, binary counts and filters must never become invented zeroes.
      this.value = null;
      this.onBranch = null;
      this.others = null;
      this.key = null;
      if (changed) this.changed?.();
    }
  }
}
