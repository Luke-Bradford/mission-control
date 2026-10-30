import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const GZ_MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** `path` if it exists, else its gzip sibling if that exists, else `path`. Never throws. */
export function transcriptFilePath(path: string): string {
  try {
    return existsSync(path) || !existsSync(`${path}.gz`) ? path : `${path}.gz`;
  } catch {
    return path;
  }
}

export interface TranscriptFile {
  size: number;
  read(buf: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}

/** Opens the plain transcript, or its gzip sibling with positions in inflated bytes. */
export function openTranscript(path: string): TranscriptFile {
  const actual = transcriptFilePath(path);
  if (!actual.endsWith(".gz")) {
    const fd = openSync(actual, "r");
    return {
      size: fstatSync(fd).size,
      read: (b, o, l, p) => readSync(fd, b, o, l, p),
      close: () => closeSync(fd),
    };
  }
  const data = gunzipSync(readFileSync(actual), { maxOutputLength: GZ_MAX_INFLATED_BYTES });
  return {
    size: data.length,
    read: (buf, offset, length, position) => {
      const got = data.copy(buf, offset, position, position + length);
      return got;
    },
    close: () => {},
  };
}
