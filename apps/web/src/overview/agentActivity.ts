import type { RunDigest } from "@mc/core";

export const ACTIVITY_MINUTES = 30;
export const ACTIVITY_MS = ACTIVITY_MINUTES * 60_000;

/** Minute buckets end at the panel clock, never at an individual agent's last burst. */
export function activityValues(digest: RunDigest | null, now: number): number[] {
  const end = Math.floor(now / 60_000) * 60_000;
  const buckets = new Map(digest?.minuteTokens ?? []);
  return Array.from(
    { length: ACTIVITY_MINUTES },
    (_, i) => buckets.get(end - (ACTIVITY_MINUTES - 1 - i) * 60_000) ?? 0,
  );
}

export const age = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** Recent token evidence, without treating tool/metadata events as output. */
export function activityLive(digest: RunDigest | null, now: number): boolean {
  return (digest?.minuteTokens ?? []).some(
    ([at, tokens]) => tokens > 0 && at <= now && now - at < 60_000,
  );
}
