/**
 * The one guarded JSON reader for stored or outside text. A malformed value gives the fallback
 * instead of throwing, so one bad row or payload cannot fail the whole read.
 */
export function parseJson<T>(raw: unknown, fallback: T, onError?: (message: string) => void): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    onError?.(`unreadable JSON: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

/**
 * An `onError` for a caller whose surrounding `try` already says what a malformed value means
 * (a refusal, a fixed message, a skipped line): the failure is thrown there as it was before.
 */
export const rethrowJson = (message: string): never => {
  throw new SyntaxError(message);
};
