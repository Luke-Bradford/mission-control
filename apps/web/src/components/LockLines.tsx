import {
  LOCK_FREE_TEXT,
  LOCK_NOBODY_WAITING,
  lockHolderText,
  lockWaitingLine,
  seatCallSign,
  type TestLockState,
} from "@mc/core";
import { useSecond } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { mss } from "../fmt.ts";

/** The test lock as `/api/test-lock` last said it; undefined until the first answer. */
export function useTestLock(): TestLockState | undefined {
  return useResource<TestLockState>(RESOURCES.testLock).data;
}

/**
 * Who holds the lock and for how long, then the seats in line (oldest first, as the server lists
 * them), or that no full suite is running. `nobodyWaiting` adds the empty-queue line to a held lock.
 */
export function LockLines({
  lock,
  nobodyWaiting = false,
}: {
  lock: TestLockState | undefined;
  nobodyWaiting?: boolean;
}) {
  const now = useSecond();
  if (lock === undefined) return null;
  const h = lock.holder;
  const waits = new Map<string, number>();
  return (
    <>
      <div className="s">
        {h === null
          ? LOCK_FREE_TEXT
          : lockHolderText(seatCallSign(h.seatId), h.command, mss(now - h.since))}
      </div>
      {lock.waiting.map((w) => {
        // one run can wait with two calls at once (parallel Bash): its run id alone repeats, so
        // each row is keyed by its run and its place among that run's waits
        const n = (waits.get(w.runId) ?? 0) + 1;
        waits.set(w.runId, n);
        return (
          <div key={`${w.runId}#${n}`} className="s warn-t">
            {lockWaitingLine(seatCallSign(w.seatId), mss(now - w.since))}
          </div>
        );
      })}
      {nobodyWaiting && h !== null && lock.waiting.length === 0 && (
        <div className="s muted">{LOCK_NOBODY_WAITING}</div>
      )}
    </>
  );
}
