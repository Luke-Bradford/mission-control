import type { AutonomyQuestion } from "@mc/core";

// Port of an earlier loop engine's SD-32 question parser (SD-32 §8).
// Strict by design: a lenient parser would surface a half-formed question as if triaged.
const KEYS = [
  "question",
  "recommendation",
  "reasoning_quote",
  "effort_sunk",
  "default_if_ignored",
  "answers",
] as const;
const STRING_KEYS = KEYS.filter((k) => k !== "answers");
// Tolerant of a trailing-whitespace info string and CRLF; first block in a comment wins.
const FENCE = /```[ \t]*autonomy-question[ \t]*\r?\n([\s\S]*?)\r?\n?```/;

/** True when any comment holds an autonomy-question fence (valid or not): older ones are then moot. */
export const hasQuestionFence = (comments: { body: string }[]): boolean =>
  comments.some((c) => FENCE.test(c.body));

function validate(obj: unknown): AutonomyQuestion | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(rec, k))) return null;
  if (!STRING_KEYS.every((k) => typeof rec[k] === "string")) return null;
  const ans = rec.answers;
  if (!Array.isArray(ans) || ans.length < 1 || ans.length > 3) return null;
  if (!ans.every((a) => typeof a === "string")) return null;
  return rec as unknown as AutonomyQuestion;
}

/**
 * The NEWEST comment containing a fence is authoritative: a later prose-only comment does not mask
 * it, and a malformed newest block yields null (never falls back to an older one). Total.
 */
export function parseAutonomyQuestion(
  comments: { body: string; createdAt: string }[] | null | undefined,
): AutonomyQuestion | null {
  if (!Array.isArray(comments)) return null;
  const candidates: { at: string; block: string }[] = [];
  for (const c of comments) {
    if (typeof c !== "object" || c === null) continue;
    if (typeof c.body !== "string") continue;
    const m = FENCE.exec(c.body);
    if (!m || m[1] === undefined) continue;
    candidates.push({ at: typeof c.createdAt === "string" ? c.createdAt : "", block: m[1] });
  }
  if (candidates.length === 0) return null;
  // ISO-8601 timestamps sort lexically; stable sort so ties keep input order (last wins).
  candidates.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const newest = candidates[candidates.length - 1];
  if (!newest) return null;
  try {
    return validate(JSON.parse(newest.block));
  } catch {
    return null;
  }
}
