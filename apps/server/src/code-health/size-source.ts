import { spawn } from "node:child_process";
import { GIT_TIMEOUT_MS, type GitExec, gitEnv, readOnlyObjectBase, realGitExec } from "../files.ts";
import { riskFile } from "./risk.ts";

export const SIZE_SCOPE_VERSION = 1;
export const SIZE_FILES_MAX = 50_000;
export const SIZE_BLOB_BYTES_MAX = 64 * 1024 * 1024;
export interface FileSizeSnapshot {
  version: number;
  analysedSha: string;
  files: { path: string; lines: number }[];
  excludedBinaryFiles: number;
  elapsedMs: number;
}
type BlobReader = (args: string[], input: string) => Promise<Buffer>;
/** Raw committed blobs only: no checkout, filters, attributes, textconv or external programs. */
const readBlobs: BlobReader = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...gitEnv(process.env), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      timeout: GIT_TIMEOUT_MS,
    });
    const chunks: Buffer[] = [];
    let size = 0,
      overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > SIZE_BLOB_BYTES_MAX) {
        overflow = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) =>
      code === 0 && !overflow
        ? resolve(Buffer.concat(chunks))
        : reject(Error("Size blob collection unavailable")),
    );
    child.stdin.end(input);
  });

export async function collectFileSizes(
  checkout: string,
  sha: string,
  deps: { exec?: GitExec; blobs?: BlobReader } = {},
): Promise<FileSizeSnapshot> {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error("Invalid size snapshot SHA");
  const started = performance.now(),
    exec = deps.exec ?? realGitExec;
  const base = await readOnlyObjectBase(checkout, exec);
  const output = await exec([...base, "ls-tree", "-rz", `${sha}^{tree}`]);
  if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw Error("Size tree output limit");
  if (output && !output.endsWith("\0")) throw Error("Incomplete size tree records");
  const entries = output
    .split("\0")
    .filter(Boolean)
    .flatMap((row) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(row);
      if (!match) {
        if (!/^(?:120000 blob|160000 commit) [a-f0-9]{40,64}\t/.test(row))
          throw Error("Invalid size tree record");
        return [];
      }
      if (match[3].includes("\uFFFD")) throw Error("Unsupported size path encoding");
      if (!riskFile(match[3])) return [];
      return [{ sha: match[2], path: match[3] }];
    });
  if (
    entries.length > SIZE_FILES_MAX ||
    new Set(entries.map((row) => row.path)).size !== entries.length
  )
    throw Error("Size file scope limit");
  const shas = [...new Set(entries.map((entry) => entry.sha))];
  const data = shas.length
    ? await (deps.blobs ?? readBlobs)([...base, "cat-file", "--batch"], shas.join("\n") + "\n")
    : Buffer.alloc(0);
  if (data.length > SIZE_BLOB_BYTES_MAX) throw Error("Size blob output limit");
  const counts = new Map<string, number | null>();
  let offset = 0;
  for (const expected of shas) {
    const end = data.indexOf(10, offset),
      header =
        end < 0
          ? null
          : /^([a-f0-9]{40,64}) blob (\d+)$/.exec(data.subarray(offset, end).toString("utf8"));
    if (!header || header[1] !== expected) throw Error("Size blob identity mismatch");
    const size = Number(header[2]),
      from = end + 1,
      until = from + size;
    if (!Number.isSafeInteger(size) || size < 0 || until >= data.length || data[until] !== 10)
      throw Error("Invalid size blob boundary");
    const bytes = data.subarray(from, until);
    let lines = 0;
    if (bytes.includes(0)) counts.set(expected, null);
    else {
      for (const byte of bytes) if (byte === 10) lines++;
      if (bytes.length && bytes[bytes.length - 1] !== 10) lines++;
      counts.set(expected, lines);
    }
    offset = until + 1;
  }
  if (offset !== data.length) throw Error("Unexpected size blob trailing data");
  let excludedBinaryFiles = 0;
  const files = entries
    .flatMap((entry) => {
      const lines = counts.get(entry.sha);
      if (lines === null) {
        excludedBinaryFiles++;
        return [];
      }
      if (lines === undefined) throw Error("Missing size blob");
      return [{ path: entry.path, lines }];
    })
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return {
    version: SIZE_SCOPE_VERSION,
    analysedSha: sha,
    files,
    excludedBinaryFiles,
    elapsedMs: performance.now() - started,
  };
}
