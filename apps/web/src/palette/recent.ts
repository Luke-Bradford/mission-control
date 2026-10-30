import { PALETTE_RECENT_KEY, readKey, writeKey } from "../storage.ts";
import { RECENT_LIMIT } from "./entries.ts";

/** The stored recent picks, newest first; anything unreadable is none. */
export function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(readKey(PALETTE_RECENT_KEY) ?? "[]");
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Put `id` first, once, and keep the newest five. */
export function rememberPick(id: string): void {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  writeKey(PALETTE_RECENT_KEY, JSON.stringify(next));
}
