import {
  parseCheckOutput,
  VERIFY_SEAT,
  type VerifyCheckResult,
  type VerifyQueueView,
} from "@mc/core";
import type { TestLock } from "../guard/lock.ts";
import type { Store } from "../store.ts";

/** Serial hub-owned validation queue. The runner is deliberately injected: it never executes in the hub process. */
export function createVerifyQueue(i: {
  store: Store;
  lock: TestLock;
  checks: (repoId: string) => readonly string[];
  runner: (job: {
    id: number;
    sha: string;
    command: string;
  }) => Promise<{ ok: boolean; output: string; durationMs: number }>;
  capacity?: () => boolean;
  now?: () => number;
  onChange?: () => void;
}) {
  const now = i.now ?? Date.now;
  const changed = i.onChange ?? (() => {});
  let ticking = false;
  const view = (): VerifyQueueView => {
    const all = i.store.verifyJobs();
    const running = all.find((j) => j.state === "running") ?? null;
    const queued = all
      .filter((j) => j.state === "queued")
      .map((j, position) => ({ ...j, position: position + 1 }));
    return {
      running: running && { ...running, position: 0 },
      queued,
      recent: all
        .filter((j) => j.endedAt !== null)
        .slice(-20)
        .reverse(),
    };
  };
  const tick = async (): Promise<void> => {
    if (ticking || i.capacity?.() === false || view().running !== null) return;
    const job = view().queued[0];
    if (!job) return;
    ticking = true;
    const controller = new AbortController();
    const key = { runId: `verify:${job.id}`, toolUseId: "job" };
    try {
      if (!(await i.lock.acquire(key, VERIFY_SEAT, "verify queue", 60_000, controller.signal)))
        return;
      i.store.setVerifyJob(job.id, "running", now());
      changed();
      const results: VerifyCheckResult[] = [];
      for (const command of i.checks(job.repoId)) {
        const current = i.store.verifyJobs().find((candidate) => candidate.id === job.id);
        if (current?.state !== "running") return;
        const result = await i.runner({ id: job.id, sha: job.sha, command });
        const afterRun = i.store.verifyJobs().find((candidate) => candidate.id === job.id);
        if (afterRun?.state !== "running") return;
        const check = {
          command,
          ok: result.ok,
          durationMs: result.durationMs,
          ...parseCheckOutput(result.output),
        };
        results.push(check);
        i.store.addCheckRun({
          runId: job.runId,
          command,
          headSha: job.sha,
          ok: result.ok,
          at: now(),
          verifyJobId: job.id,
          failing: check,
          durationMs: result.durationMs,
        });
      }
      if (i.store.verifyJobs().find((candidate) => candidate.id === job.id)?.state !== "running")
        return;
      i.store.setVerifyJob(
        job.id,
        results.every((result) => result.ok) ? "passed" : "failed",
        now(),
      );
    } catch (error) {
      i.store.setVerifyJob(
        job.id,
        "error",
        now(),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      i.lock.release(key);
      ticking = false;
      changed();
      void tick();
    }
  };
  return {
    enqueue(runId: string, seatId: string, repoId: string, sha: string): number {
      const id = i.store.enqueueVerifyJob({ runId, seatId, repoId, sha, at: now() });
      changed();
      void tick();
      return id;
    },
    tick,
    view,
    restore(): void {
      i.store.resetRunningVerifyJobs();
      void tick();
    },
  };
}
