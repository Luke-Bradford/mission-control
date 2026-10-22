import { STREAM_TEXT_MAX } from "@mc/core";

/** Characters kept beyond the maximum before cleaning, so redactions have room to shrink. */
const SLICE_SLACK = 4096;

// Terminal escapes: CSI (`ESC [ … final`), OSC/DCS/APC/PM/SOS strings (up to BEL or ST), and
// two-character ESC sequences (an unterminated string loses only its ESC and introducer). Then
// C0 controls other than \n and \t.
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROLS = /[\x00-\x08\x0b-\x1f]/g;

const REDACTED = "[redacted]";
/** PEM first (it spans lines and may hold other matches); an unterminated block runs to the end. */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
];
const JWT_START = "eyJ";
const isB64Url = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;

/** The index after the run of base64url characters starting at `i` (`i` itself when none). */
function endOfRun(s: string, i: number): number {
  while (i < s.length && isB64Url(s.charCodeAt(i))) i++;
  return i;
}

/**
 * Where the JWT starting at `start` ends, with the end of its second part: its three dot-separated
 * base64url parts, the first starting `eyJ` and longer than it. `end` is -1 when there is none;
 * `first` is the end of the first run either way.
 */
function readJwt(s: string, start: number): { first: number; second: number; end: number } {
  const first = endOfRun(s, start + JWT_START.length);
  if (first > start + JWT_START.length && s[first] === ".") {
    const second = endOfRun(s, first + 1);
    if (second > first + 1 && s[second] === ".") {
      const third = endOfRun(s, second + 1);
      if (third > second + 1) return { first, second, end: third };
    }
  }
  return { first, second: -1, end: -1 };
}

/**
 * Each `eyJ…` JWT replaced with `[redacted]`. A scanner rather than a regex: a failed attempt
 * resumes after the run it read, since every later start inside that run fails the same way, so the
 * scan is linear. A token's third part running into the next token's header (`a.b.ceyJd.e.f`) is
 * split at that `eyJ` when what follows it is a whole token, so neither token's tail survives.
 */
export function redactJwts(s: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const start = s.indexOf(JWT_START, from);
    if (start < 0) break;
    const jwt = readJwt(s, start);
    let { end } = jwt;
    if (end < 0) {
      from = Math.max(jwt.first, start + 1);
      continue;
    }
    // Only the first `eyJ` in the third part is tried: bounded work. One at its very start is an
    // unsecured token (empty signature) followed by the next.
    const next = s.indexOf(JWT_START, jwt.second + 1);
    if (next >= 0 && next < end && readJwt(s, next).end >= 0) end = next;
    out += s.slice(last, start) + REDACTED;
    last = from = end;
  }
  return out + s.slice(last);
}
/** `bearer …` / `token …`: the word stays, the value goes. */
const AUTH_WORD = /(bearer|token)\s+[A-Za-z0-9._-]{20,}/gi;
/** Characters a credential is made of: a run of them at the end of a slice may be a cut token. */
const TOKEN_CHAR = /[A-Za-z0-9._+/=-]/;
/** Longer than any credential above needs to be recognised; bounds what a cut can remove. */
const TOKEN_TAIL_MAX = 256;

/** `s` without its trailing run of token characters, at most TOKEN_TAIL_MAX of them. */
function dropTrailingToken(s: string): string {
  let i = s.length;
  while (i > 0 && s.length - i < TOKEN_TAIL_MAX && TOKEN_CHAR.test(s[i - 1] as string)) i--;
  return s.slice(0, i);
}

/**
 * Transcript text made safe to show as inert text: terminal escapes and control characters
 * removed, obvious credentials redacted to `[redacted]`, cut at `max` (default STREAM_TEXT_MAX) with
 * `…`. The input is first sliced to `max` + 4096 characters, so a multi-MB tool result is never
 * scanned whole; when that slice cut the input, a trailing partial token is dropped too.
 */
export function cleanText(s: string, max = STREAM_TEXT_MAX): string {
  const sliced = s.length > max + SLICE_SLACK;
  let out = sliced ? s.slice(0, max + SLICE_SLACK) : s;
  out = out.replace(ESCAPES, "").replace(CONTROLS, "");
  for (const re of SECRETS) out = out.replace(re, REDACTED);
  out = redactJwts(out);
  out = out.replace(AUTH_WORD, `$1 ${REDACTED}`);
  if (sliced) out = dropTrailingToken(out);
  if (!sliced && out.length <= max) return out;
  let cut = out.slice(0, max - 1);
  // Never end on half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
