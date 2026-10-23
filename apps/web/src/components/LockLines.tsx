import {
  LOCK_FREE_TEXT,
  lockHolderText,
  lockUsualText,
  lockWaitingLine,
  type TestLockHistory,
  type TestLockState,
} from "@mc/core";
import { useSecond } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { mss } from "../fmt.ts";
import { useSeatName } from "../seatName.ts";

/** The test lock as `/api/test-lock` last said it; undefined until the first answer. */
export function useTestLock(): TestLockState | undefined {
  return useResource<TestLockState>(RESOURCES.testLock).data;
}

/** The usual length of this command, once enough completed holds are recorded. */
export function LockUsual({
  command,
  since,
  prefix = "",
}: {
  command: string;
  since: number;
  prefix?: string;
}) {
  const history = useResource<TestLockHistory>(RESOURCES.testLockHistory).data;
  const now = useSecond();
  const usual = history?.usualMs[command];
  return usual === undefined ? null : (
    <span className={now - since > usual ? "warn-t" : undefined}>
      {prefix}
      {lockUsualText(Math.round(usual / 60_000), now - since > usual)}
    </span>
  );
}

/**
 * Who holds the lock and for how long, then the seats in line (oldest first, as the server lists
 * them), or that no full suite is running.
 */
export function LockLines({ lock }: { lock: TestLockState | undefined }) {
  const nameOf = useSeatName();
  const now = useSecond();
  if (lock === undefined) return null;
  const h = lock.holder;
  const waits = new Map<string, number>();
  return (
    <>
      <div className="s">
        {h === null
          ? LOCK_FREE_TEXT
          : lockHolderText(nameOf(h.seatId), h.command, mss(now - h.since))}
      </div>
      {h && (
        <div className="s fg2">
          <LockUsual command={h.command} since={h.since} />
        </div>
      )}
      {lock.waiting.map((w) => {
        // one run can wait with two calls at once (parallel Bash): its run id alone repeats, so
        // each row is keyed by its run and its place among that run's waits
        const n = (waits.get(w.runId) ?? 0) + 1;
        waits.set(w.runId, n);
        return (
          <div key={`${w.runId}#${n}`} className="s warn-t">
            {lockWaitingLine(nameOf(w.seatId), mss(now - w.since))}
          </div>
        );
      })}
    </>
  );
}
