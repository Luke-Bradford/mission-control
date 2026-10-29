export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function str(v: unknown): string | null;
export function str(v: unknown, fallback: string): string;
export function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}

/**
 * The bytes a transcript line's compaction cut from a result (#934): the `outputTruncated.bytes` of
 * the owner, summed with those of its content parts; null when nothing was cut.
 */
export function cutBytes(owner: unknown): number | null {
  if (typeof owner !== "object" || owner === null) return null;
  const o = owner as { outputTruncated?: { bytes?: unknown }; content?: unknown };
  let total = 0;
  const own = o.outputTruncated?.bytes;
  if (typeof own === "number" && Number.isFinite(own)) total += own;
  if (Array.isArray(o.content)) for (const part of o.content) total += cutBytes(part) ?? 0;
  return total > 0 ? total : null;
}
