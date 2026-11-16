import type { BugMissedReason } from "@mc/core";

export interface MissedFacts {
  /** The introducing PR had a finished hub review. */
  hasReview: boolean;
  /** The Done-when lines the introducing PR's ticket carried, from its runs. */
  doneWhen: string[];
  bugTitle: string;
  /** Source files the fix changed. */
  fixedFiles: string[];
  /** Files the introducing PR changed. */
  introFiles: string[];
}

const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "when",
  "than",
  "then",
  "does",
  "into",
  "should",
]);
const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/i;
const stem = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.(test|spec)(?=\.)/i, "").replace(/\.[^.]+$/, "");

/**
 * Why the introducing PR let the bug through, from recorded data: no hub review (review), else no
 * Done-when line sharing a word with the bug (requirement), else no test file named for a fixed
 * file (test), else none.
 */
export function classifyMissed(f: MissedFacts): BugMissedReason {
  if (!f.hasReview) return "review";
  const bug = words(f.bugTitle);
  if (!f.doneWhen.some((line) => [...words(line)].some((w) => bug.has(w)))) return "requirement";
  const tests = f.introFiles.filter((p) => TEST_PATH.test(p)).map(stem);
  if (!f.fixedFiles.some((p) => tests.includes(stem(p)))) return "test";
  return "none";
}
