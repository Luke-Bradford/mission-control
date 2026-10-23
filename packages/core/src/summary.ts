/** Longest `Run.summary`, in characters, including the `…` of a cut one. */
export const WORK_SUMMARY_MAX = 240;
/** Longest `RunDigest.lastText`, in characters, including the `…` of a cut one. */
export const LAST_TEXT_MAX = 160;
/** Longest `liveTool.detail`, in characters, including the `…` of a cut one. */
export const LIVE_DETAIL_MAX = 80;

export const ELLIPSIS = "…";
const SENTENCE_END = new Set([".", "!", "?"]);
const SPACE = /\s/;

// A leading DONE that stands alone: bold, or followed by `.`, `:`, `!`, a dash or the line end.
// Not "Done with the work" or "Done-ish".
const BOLD_DONE = /^\*\*done[.:!]?\*\*[\s.:!—–-]*/i;
const DONE_MARKER =
  /^done(?:[.:!]+[ \t]*|[ \t]*[—–][ \t]*|[ \t]+-{1,2}[ \t]+|[ \t]*✅[ \t]*|[ \t]*(?=\n|$))/i;
// `e.g.` and the like do not end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|cf|mr|mrs|ms|dr)\.$/i;
// `etc.` ends a sentence unless the sentence goes on in lower case.
const ETC = /(?:^|[\s(])etc\.$/i;
const LOWER_START = /^\s+[a-z]/;
// A list number is short: "2026. A year." is a year.
const LIST_NUMBER = /^\d{1,3}[.)]\s+/;
// A first token in backticks (an identifier or a command) keeps its case.
const STARTS_IN_CODE = /^\s*(?:(?:[-*+>]|\d{1,3}[.)]|#+)\s+)*(?:\*\*)?`/;
// A heading line: `#`s and a space; or a line that is bold from end to end.
const HEADING_LINE = /^#+\s/;
const BOLD_LINE = /^\*\*[^*]+\*\*$/;
const ENDS_SENTENCE = /[.!?]["')\]]*$/;
// A piece ending in `:` is followed by a space, not a `; `.
const JOINS_SENTENCE = /[.!?:]["')\]]*$/;

/** `s` cut to `max` code points, at a word boundary when it has one, with a `…` that fits in `max`. */
export function cutAtWord(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const room = chars.slice(0, max - 1);
  const atWord = chars[max - 1] === " " ? -1 : room.lastIndexOf(" ");
  const cut = (atWord > 0 ? room.slice(0, atWord) : room).join("");
  return `${cut.replace(/[\s,;:]+$/, "")}${ELLIPSIS}`;
}

/** The text without a leading DONE marker (a leading heading's `#`s too), and whether one was there. */
function skipDone(text: string): { body: string; skipped: boolean } {
  const t = text.trimStart().replace(/^#+\s+/, "");
  const rest = BOLD_DONE.test(t) ? t.replace(BOLD_DONE, "") : t.replace(DONE_MARKER, "");
  return { body: rest, skipped: rest !== t };
}

/** A line's text with its Markdown markers stripped; null for a table row, a rule or a code fence. */
function lineText(line: string): string | null {
  const s = line.trim();
  if (s === "" || s.startsWith("|") || s.startsWith("```") || /^[-:|\s]{3,}$/.test(s)) return null;
  if (s.replace(/`[^`]*`/g, "").includes("|")) return null; // a table row with no leading pipe
  return s
    .replace(/^#+\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replaceAll("**", "")
    .replace(LIST_NUMBER, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|[\s(])__([^_\s][^_]*)__(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:!?])/g, "$1$2");
}

/** True when the `.` at `i` follows an abbreviation, so the sentence (begun at `start`) goes on. */
function continues(line: string, start: number, i: number): boolean {
  const upTo = line.slice(start, i + 1);
  return ABBREVIATION.test(upTo) || (ETC.test(upTo) && LOWER_START.test(line.slice(i + 1)));
}

/** A line's sentences: each ends at `.`, `!` or `?` before whitespace or the end, outside a backtick span. */
function sentencesOf(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inCode = false;
  const take = (end: number) => {
    const s = line.slice(start, end).replaceAll("`", "").replace(/\s+/g, " ").trim();
    if (s !== "") out.push(s);
    start = end;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "`") inCode = !inCode;
    const atBreak = i + 1 === line.length || SPACE.test(line[i + 1] as string);
    if (!inCode && SENTENCE_END.has(c) && atBreak && !continues(line, start, i)) take(i + 1);
  }
  take(line.length);
  return out;
}

/**
 * The text's sentences, the first `maxSentences` that fit in `max` characters (a `…` after a cut).
 * Sentences join with a space, a line without end punctuation (a heading, a bullet) with `; `. A
 * first sentence over the cap is cut at a word boundary.
 */
function sentencesUpTo(text: string, max: number, maxSentences: number): string | null {
  let inFence = false;
  const sentences = text.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return [];
    }
    const t = inFence ? null : lineText(line);
    return t === null ? [] : sentencesOf(t);
  });
  if (sentences.length === 0) return null;
  const taken: string[] = [];
  let out = "";
  for (const s of sentences) {
    if (taken.length === maxSentences) break;
    const next = out === "" ? s : `${out}${JOINS_SENTENCE.test(out) ? " " : "; "}${s}`;
    // Room for the `…` unless this is the last sentence that will be taken.
    const last = taken.length + 1 === Math.min(maxSentences, sentences.length);
    if (Array.from(next).length > (last ? max : max - 1)) break;
    out = next;
    taken.push(s);
  }
  if (taken.length === 0) return cutAtWord(sentences[0] as string, max);
  if (taken.length === sentences.length || taken.length === maxSentences) return out;
  // Cut: do not leave a heading ("Changes:", "Critical") dangling before the `…`.
  while (taken.length > 1 && !ENDS_SENTENCE.test(taken[taken.length - 1] as string)) taken.pop();
  return `${taken.reduce((acc, s) => `${acc}${JOINS_SENTENCE.test(acc) ? " " : "; "}${s}`)}${ELLIPSIS}`;
}

function describe(text: string, max: number, maxSentences: number): string | null {
  const { body, skipped } = skipDone(text);
  const out = sentencesUpTo(body, max, maxSentences);
  if (!skipped || out === null || STARTS_IN_CODE.test(body)) return out;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * What a run did, from its final reply: a leading DONE marker skipped (the first letter then
 * capitalised), then the first sentences up to WORK_SUMMARY_MAX characters. Markdown markers
 * (`**`, backticks, headings, list markers, links, `_italic_`, table rows) are stripped. Null when
 * nothing is left.
 */
export function workSummary(text: string): string | null {
  return describe(text, WORK_SUMMARY_MAX, Number.POSITIVE_INFINITY);
}

/** The text from its first line that is neither blank nor a heading; the text itself when none is. */
function skipHeadings(text: string): string {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => {
    const s = l.trim();
    return s !== "" && !HEADING_LINE.test(s) && !BOLD_LINE.test(s);
  });
  return at <= 0 ? text : lines.slice(at).join("\n");
}

/**
 * The first sentence of `text`, as workSummary reads it, cut at LAST_TEXT_MAX; null when empty.
 * Leading heading lines (`## Summary`, `**Plan**`) are skipped when text follows them.
 */
export function leadSentence(text: string): string | null {
  const { body, skipped } = skipDone(text);
  const rest = skipHeadings(skipped ? body : text);
  const out = describe(rest, LAST_TEXT_MAX, 1) ?? describe(text, LAST_TEXT_MAX, 1);
  if (!skipped || out === null || STARTS_IN_CODE.test(rest)) return out;
  return out.charAt(0).toUpperCase() + out.slice(1);
}
