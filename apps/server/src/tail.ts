import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Most bytes a single readNewLines call will read (a single longer line is still returned whole). */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Longest single line readNewLines will read; longer lines are skipped. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
const SCAN_CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

export interface TailResult {
  lines: string[];
  nextOffset: number;
  /** True when the file was smaller than fromOffset and reading restarted from 0: discard prior facts. */
  reset: boolean;
}

function readRange(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** Position of the first "\n" at or after `from`, scanning in bounded chunks; -1 if none before `size`. */
function findNewline(fd: number, from: number, size: number): number {
  for (let pos = from; pos < size; pos += SCAN_CHUNK) {
    const buf = readRange(fd, pos, Math.min(SCAN_CHUNK, size - pos));
    const i = buf.indexOf(NEWLINE);
    if (i !== -1) return pos + i;
  }
  return -1;
}

export interface TailOptions {
  /** Most bytes read per call (default MAX_READ_BYTES). */
  maxBytes?: number;
  /** Longest single line that will be read (default MAX_LINE_BYTES); longer lines are skipped. */
  maxLineBytes?: number;
  /** Receives fs errors and skipped/oversized-line reports; the read itself never throws. */
  onError?: (err: unknown) => void;
}

/**
 * Read complete lines appended to `path` since byte `fromOffset`, at most `maxBytes` per call
 * (the caller loops until nextOffset stops advancing). A trailing partial line is left for the next
 * call. A single line longer than maxBytes is returned alone; one longer than maxLineBytes is
 * skipped (nextOffset moves past it, onError is told). A file shorter than fromOffset is treated as
 * truncated/rotated and re-read from 0 with reset=true. Any fs error (missing, unreadable,
 * a directory...) yields no lines, an unchanged offset and an onError call; it never throws.
 * Trailing "\r" is stripped from each line.
 */
export function readNewLines(path: string, fromOffset: number, opts: TailOptions = {}): TailResult {
  const maxBytes = opts.maxBytes ?? MAX_READ_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const reset = size < fromOffset;
    const start = reset ? 0 : fromOffset;
    const none = { lines: [], nextOffset: start, reset };
    if (start >= size) return none;

    const window = readRange(fd, start, Math.min(maxBytes, size - start));
    let end = window.lastIndexOf(NEWLINE);
    let data = window;
    if (end === -1) {
      // No newline in the window: either a partial line at EOF, or one longer than the cap.
      if (start + window.length >= size) return none;
      const nl = findNewline(fd, start + window.length, size);
      if (nl === -1) {
        if (size - start > maxLineBytes) {
          opts.onError?.(
            new Error(`line at offset ${start} of ${path} exceeds ${maxLineBytes} bytes`),
          );
        }
        return none;
      }
      if (nl - start > maxLineBytes) {
        opts.onError?.(new Error(`skipped ${nl - start}-byte line at offset ${start} of ${path}`));
        return { lines: [], nextOffset: nl + 1, reset };
      }
      end = nl - start;
      data = readRange(fd, start, end + 1);
    }
    const lines = data
      .subarray(0, end)
      .toString("utf8")
      .split("\n")
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    return { lines, nextOffset: start + end + 1, reset };
  } catch (err) {
    opts.onError?.(err);
    return { lines: [], nextOffset: fromOffset, reset: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing useful to do
      }
    }
  }
}
