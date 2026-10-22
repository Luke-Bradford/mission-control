import { type ConfigView, STREAM_TEXT_MAX } from "@mc/core";
import { cutStart, cutText, firstLine } from "../fmt.ts";

/** A collapsed tool row's target is cut to this many characters. */
export const TARGET_MAX = 80;
/** A collapsed tool row's result is cut to this many characters. */
export const RESULT_MAX = 100;

/** Input keys that name a file, in the order tried. */
const PATH_KEYS = ["file_path", "notebook_path"] as const;

/**
 * Any seat worktree, `.../worktrees/<seat>-<digits>`: the fallback while the config loads, or for a
 * path outside the configured ones.
 */
const ANY_WORKTREE = String.raw`(?:/[^\s"'/]+)*(?<!\.git)/worktrees/[^/\s"']+-\d+`;

/**
 * A worktree path starts the text or follows whitespace, a quote, a bracket, `=`, `:`, `,`, `<` or
 * `|` (so `at fn (/…/a.ts:3:4)` is shortened); never the middle of a path.
 */
const LEFT = String.raw`(?<![^\s"'\x60=:,<|(\[])`;

/** Text is searched for worktree paths in at most the stream's own text cap of leading characters. */
const SCAN_MAX = STREAM_TEXT_MAX;

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shortens text that names files inside the row's worktree. */
export interface Relativise {
  /** Every `<worktree>/` in the text removed. */
  path: (s: string) => string;
  /** A leading `cd <worktree> &&` removed. */
  command: (s: string) => string;
}

/**
 * A loop's worktree is `loops[].worktree`; a crew seat's is `<crew.worktrees>/<seatId>-<issue>`.
 * Without the config only the `/worktrees/<seat>-<digits>/` shape is known.
 */
export function relativiser(config: ConfigView | undefined, seatId: string): Relativise {
  const roots: string[] = [];
  const loop = config?.loops.find((l) => l.id === seatId);
  if (loop) roots.push(reEscape(loop.worktree.replace(/\/+$/, "")));
  if (config?.crew) {
    roots.push(`${reEscape(config.crew.worktrees.replace(/\/+$/, ""))}/${reEscape(seatId)}-\\d+`);
  }
  roots.push(ANY_WORKTREE);
  const any = roots.join("|");
  const strip = new RegExp(`${LEFT}(?:${any})/`, "g");
  const cd = new RegExp(`^\\s*cd\\s+["']?(?:${any})/?["']?\\s*&&\\s*`);
  // the search is quadratic in the worst case, so only the head of a long text is searched
  return {
    path: (s) =>
      s.length <= SCAN_MAX
        ? s.replace(strip, "")
        : s.slice(0, SCAN_MAX).replace(strip, "") + s.slice(SCAN_MAX),
    command: (s) => s.replace(cd, ""),
  };
}

/** The tool's input as an object, parsed once; null when it was cut short or is not an object. */
function parse(input: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(input);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A string field of the input; scans the raw text when the JSON was cut short. */
function field(input: string, obj: Record<string, unknown> | null, key: string): string | null {
  if (obj) {
    const f = obj[key];
    return typeof f === "string" ? f : null;
  }
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/**
 * What a tool call acted on, short: a worktree-relative path (cut from the left, so the file name
 * stays), a Bash command's first line, or a Grep/Glob pattern, else the path searched.
 */
export function toolTarget(input: string, rel: Relativise): string {
  const obj = parse(input);
  for (const k of PATH_KEYS) {
    const p = field(input, obj, k);
    if (p) return cutStart(rel.path(p), TARGET_MAX);
  }
  const cmd = field(input, obj, "command");
  if (cmd?.trim()) return cutText(rel.path(rel.command(firstLine(cmd))), TARGET_MAX);
  const pattern = field(input, obj, "pattern");
  if (pattern) return cutText(firstLine(pattern), TARGET_MAX);
  const dir = field(input, obj, "path");
  return dir ? cutText(rel.path(dir), TARGET_MAX) : "";
}

/** The result's first line with text, worktree paths shortened, cut to one short line. */
export function toolResult(result: string, error: boolean, rel: Relativise): string {
  return cutText(`${error ? "error: " : ""}${rel.path(firstLine(result))}`, RESULT_MAX);
}
