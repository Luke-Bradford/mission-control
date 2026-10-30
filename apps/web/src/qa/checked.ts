import { QA_CHECKED_HEADS_KEY, readKey, writeKey } from "../storage.ts";

export { QA_CHECKED_HEADS_KEY } from "../storage.ts";

type CheckedHeads = Record<string, string>;

const listeners = new Set<() => void>();

/** Calls `fn` after every mark or undo in this window, so a mounted view can re-read the marks. */
export function onCheckedChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const checkedKey = (repoId: string, number: number): string => `${repoId}:${number}`;

function heads(): CheckedHeads {
  const raw = readKey(QA_CHECKED_HEADS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((value) => typeof value === "string")
    )
      return {};
    return parsed as CheckedHeads;
  } catch {
    return {};
  }
}

export const checkedHead = (repoId: string, number: number): string | null =>
  heads()[checkedKey(repoId, number)] ?? null;

export function markChecked(repoId: string, number: number, headSha: string): void {
  writeKey(
    QA_CHECKED_HEADS_KEY,
    JSON.stringify({ ...heads(), [checkedKey(repoId, number)]: headSha }),
  );
  for (const fn of listeners) fn();
}

export function undoChecked(repoId: string, number: number): void {
  const next = heads();
  delete next[checkedKey(repoId, number)];
  writeKey(QA_CHECKED_HEADS_KEY, JSON.stringify(next));
  for (const fn of listeners) fn();
}
