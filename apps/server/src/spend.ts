import type { Run, RunDigest } from "@mc/core";
import { endOf } from "./views.ts";

/** Message-time spend, falling back to wall time when no attempt tokens were recorded. */
export function runSpend(
  run: Run,
  digest: RunDigest | undefined,
  since: number,
  now: number,
  bucketMs?: number,
): number[] {
  const width = bucketMs ?? Math.max(1, now - since);
  const spend = Array<number>(
    bucketMs === undefined ? 1 : Math.floor((now - since) / width) + 1,
  ).fill(0);
  const usage = digest?.attemptUsage;
  const totalTokens = usage?.reduce((sum, u) => sum + u.tokens, 0) ?? 0;
  if (usage && totalTokens > 0) {
    for (const u of usage) {
      if (u.at === null || u.at < since || u.at > now) continue;
      const i = Math.min(spend.length - 1, Math.floor((u.at - since) / width));
      spend[i] = (spend[i] ?? 0) + ((run.costUsd ?? 0) * u.tokens) / totalTokens;
    }
    return spend;
  }
  const until = endOf(run, now);
  const wall = until - run.startedAt;
  for (let i = 0; i < spend.length; i++) {
    const a = since + i * width;
    const b = Math.min(now, a + width);
    spend[i] =
      (run.costUsd ?? 0) *
      (wall <= 0
        ? Number(run.startedAt >= a && run.startedAt < b)
        : Math.max(0, Math.min(until, b) - Math.max(run.startedAt, a)) / wall);
  }
  return spend;
}
