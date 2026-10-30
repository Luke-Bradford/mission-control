import { openTranscript, type TranscriptFile } from "./transcript-file.ts";

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

function readRange(fd: TranscriptFile, pos: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fd.read(buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** Position of the first "\n" at or after `from`, scanning in bounded chunks; -1 if none before `size`. */
function findNewline(fd: TranscriptFile, from: number, size: number): number {
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
  let fd: TranscriptFile | null = null;
  try {
    fd = openTranscript(path);
    const size = fd.size;
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
        fd.close();
      } catch {
        // nothing useful to do
      }
    }
  }
}

export interface OffsetSinceOptions {
  /** Bytes read per backward step (default 1 MB). */
  chunk?: number;
  /** Furthest back from the end of the file the scan goes (default 16 MB). */
  maxBytes?: number;
}

/** The "timestamp" of one JSONL line in ms, or null when it has none. */
function lineTime(line: string): number | null {
  const found = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
  const at = found ? Date.parse(found[1] as string) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

/**
 * The byte offset, on a line start, from which reading `path` covers everything at or after
 * `cutoff` (ms): the line after the last one stamped before the cutoff. Scans back from the end of
 * the file in chunks, never further than `maxBytes` (then the first complete line within that),
 * and answers 0 when no line is older than the cutoff or the file can't be read.
 */
export function offsetSince(path: string, cutoff: number, opts: OffsetSinceOptions = {}): number {
  const chunk = opts.chunk ?? SCAN_CHUNK;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  let fd: TranscriptFile | null = null;
  try {
    fd = openTranscript(path);
    const size = fd.size;
    const floor = Math.max(0, size - maxBytes);
    // `after` is the start of the text read so far; a line may straddle the chunk boundary.
    let after = size;
    let tail = Buffer.alloc(0);
    while (after > floor) {
      const from = Math.max(floor, after - chunk);
      tail = Buffer.concat([readRange(fd, from, after - from), tail]);
      after = from;
      // lines wholly inside `tail`, newest last; the first piece is partial unless at file start
      const starts: number[] = [];
      for (let i = tail.indexOf(NEWLINE); i !== -1; i = tail.indexOf(NEWLINE, i + 1)) {
        starts.push(i + 1);
      }
      const complete = after === 0 ? [0, ...starts] : starts;
      for (let k = complete.length - 1; k >= 0; k--) {
        const lineStart = complete[k] as number;
        const end = tail.indexOf(NEWLINE, lineStart);
        if (end === -1) continue; // trailing partial line
        const at = lineTime(tail.subarray(lineStart, end).toString("utf8"));
        if (at !== null && at < cutoff) return after + end + 1;
      }
      if (after === 0) return 0;
      if (after <= floor) break;
    }
    if (floor === 0) return 0;
    // capped: begin at the first complete line inside the scanned span
    const nl = tail.indexOf(NEWLINE);
    return nl === -1 ? size : floor + nl + 1;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        fd.close();
      } catch {
        // nothing useful to do
      }
    }
  }
}
