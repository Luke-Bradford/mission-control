export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function str(v: unknown): string | null;
export function str(v: unknown, fallback: string): string;
export function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}

/**
 * How long a result was before the transcript's compaction cut it (#934), given the length of the
 * text it holds now: that length plus, for the owner and each of its content parts, the marker's
 * `originalBytes` less the text kept. Null when nothing was cut.
 */
export function originalBytes(owner: unknown, keptLength: number): number | null {
  const extra = (o: unknown): number => {
    if (typeof o !== "object" || o === null) return 0;
    const v = o as {
      outputTruncated?: { originalBytes?: unknown };
      content?: unknown;
      aggregatedOutput?: unknown;
      text?: unknown;
    };
    let total = 0;
    const original = v.outputTruncated?.originalBytes;
    if (typeof original === "number" && Number.isFinite(original)) {
      const kept = [v.content, v.aggregatedOutput, v.text].find((x) => typeof x === "string");
      total += original - (typeof kept === "string" ? kept.length : 0);
    }
    if (Array.isArray(v.content)) for (const part of v.content) total += extra(part);
    return total;
  };
  const more = extra(owner);
  return more > 0 ? keptLength + more : null;
}
