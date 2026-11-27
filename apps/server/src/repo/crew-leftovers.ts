/**
 * Files created by crew tools outside the hub data folder. Every path is narrowed to a configured
 * crew worktree or to the two Chromium names before it is read or removed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  type Dirent,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export const CREW_TRANSCRIPT_GZIP_AFTER_MS = 24 * 60 * 60_000;
export const CREW_TRANSCRIPT_DELETE_AFTER_MS = 14 * 24 * 60 * 60_000;
export const BROWSER_LEFTOVER_AFTER_MS = 6 * 60 * 60_000;

const TRANSCRIPT = /\.jsonl(?:\.gz)?$/;
const BROWSER_LEFTOVER = /^(?:playwright_chromiumdev_profile-|com\.google\.Chrome\.)/;
const TRANSCRIPT_PREFIX_BYTES = 64 * 1024;

export interface CrewLeftoverInput {
  now: number;
  worktrees: string | undefined;
  claudeProjects: string;
  codexSessions?: string;
  tmp: string;
  previews?: string;
  /** Worktrees held by a seat or currently being started. Their project folders are left whole. */
  liveWorktrees: ReadonlySet<string>;
  /** Supplying process lines avoids a process-table read in tests. Null means process safety is unknown. */
  processLines?: readonly string[] | null;
}

export interface CrewLeftoverResult {
  gzipped: number;
  deleted: number;
  browserRemoved: number;
  skippedLive: number;
}

export interface CrewLeftoverFootprint {
  claudeProjectsBytes: number;
  codexSessionsBytes: number;
  browserProfilesBytes: number;
  chromeTempBytes: number;
  worktreesBytes: number;
  previewsBytes: number;
}

/** Claude maps an absolute project path to this folder name. */
export const crewProjectName = (worktree: string): string => resolve(worktree).replaceAll("/", "-");

const list = (path: string): Dirent<string>[] => {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
};

const bytes = (path: string): number => {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  return list(path).reduce((total, entry) => total + bytes(join(path, entry.name)), 0);
};

const processTable = (): string[] | null => {
  try {
    return execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" }).split("\n");
  } catch {
    // Without the table, deleting a browser profile could end a live browser's session.
    return null;
  }
};

/** All paths with an open descriptor, including process working directories. Null keeps deletion conservative. */
const openPaths = (): string[] | null => {
  try {
    const result = spawnSync("lsof", ["-Fn"], { encoding: "utf8", maxBuffer: 16 * 2 ** 20 });
    if (result.error || result.signal || result.status === null) return null;
    if (result.stderr !== "") return null;
    // `lsof` uses 1 for an otherwise successful search with no matching files.
    if (result.status !== 0 && result.status !== 1) return null;
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
  } catch {
    return null;
  }
};

const pathInUse = (path: string, paths: readonly string[]): boolean =>
  paths.some((open) => open === path || open.startsWith(`${path}${sep}`));

const crewProjects = (root: string, worktrees: string | undefined): string[] => {
  if (worktrees === undefined) return [];
  const prefix = `${crewProjectName(worktrees)}-`;
  return list(root)
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(root, entry.name));
};

const walkFiles = (root: string, visit: (path: string) => void): void => {
  for (const entry of list(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
};

/** The session metadata carries the worktree cwd. A malformed or unknown session is never ours. */
const plainPrefix = (path: string): Buffer | null => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const text = Buffer.alloc(TRANSCRIPT_PREFIX_BYTES);
    return text.subarray(0, readSync(fd, text));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** Stops inflating once ownership metadata is found; old multi-gigabyte sessions stay bounded. */
const gzipPrefix = async (path: string): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of createReadStream(path).pipe(createGunzip())) {
      const next = Buffer.from(chunk);
      const take = Math.min(next.length, TRANSCRIPT_PREFIX_BYTES - size);
      chunks.push(next.subarray(0, take));
      size += take;
      if (size === TRANSCRIPT_PREFIX_BYTES) break;
    }
    return Buffer.concat(chunks, size);
  } catch {
    return null;
  }
};

const transcriptWorktree = async (
  path: string,
  worktrees: string | undefined,
): Promise<string | null> => {
  if (worktrees === undefined) return null;
  const text = path.endsWith(".gz") ? await gzipPrefix(path) : plainPrefix(path);
  if (text === null) return null;
  const start = text.toString("utf8");
  const root = `${resolve(worktrees)}/`;
  for (const match of start.matchAll(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const cwd = JSON.parse(`"${match[1]}"`) as unknown;
      if (typeof cwd === "string" && resolve(cwd).startsWith(root)) return resolve(cwd);
    } catch {
      // A partial JSONL write is not proof this belongs to the crew.
    }
  }
  return null;
};

const cleanTranscript = async (
  path: string,
  now: number,
  out: CrewLeftoverResult,
): Promise<void> => {
  if (!TRANSCRIPT.test(path)) return;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  const age = now - st.mtimeMs;
  try {
    if (age >= CREW_TRANSCRIPT_DELETE_AFTER_MS) {
      rmSync(path, { force: true });
      out.deleted++;
    } else if (!path.endsWith(".gz") && age >= CREW_TRANSCRIPT_GZIP_AFTER_MS) {
      const compressed = `${path}.gz`;
      const tmp = `${compressed}.tmp`;
      // A stopped pass can leave this file behind. The source remains until the complete stream
      // has been atomically renamed, and `finally` leaves the next hourly pass a clear retry.
      rmSync(tmp, { force: true });
      try {
        await pipeline(
          createReadStream(path),
          createGzip(),
          createWriteStream(tmp, { flags: "wx" }),
        );
        renameSync(tmp, compressed);
        utimesSync(compressed, st.atime, st.mtime);
        rmSync(path, { force: true });
        out.gzipped++;
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  } catch {
    // The next hourly pass retries a file that another process changed or removed.
  }
};

/** Cleans only crew Claude projects and abandoned Chromium temporary entries. */
export async function cleanupCrewLeftovers(input: CrewLeftoverInput): Promise<CrewLeftoverResult> {
  const out: CrewLeftoverResult = { gzipped: 0, deleted: 0, browserRemoved: 0, skippedLive: 0 };
  const liveProjects = new Set([...input.liveWorktrees].map(crewProjectName));
  for (const project of crewProjects(input.claudeProjects, input.worktrees)) {
    if (liveProjects.has(project.slice(input.claudeProjects.length + 1))) {
      out.skippedLive++;
      continue;
    }
    const paths: string[] = [];
    walkFiles(project, (path) => paths.push(path));
    for (const path of paths) {
      if ((await transcriptWorktree(path, input.worktrees)) === null) continue;
      await cleanTranscript(path, input.now, out);
    }
  }
  if (input.codexSessions !== undefined) {
    const paths: string[] = [];
    walkFiles(input.codexSessions, (path) => paths.push(path));
    for (const path of paths) {
      const worktree = await transcriptWorktree(path, input.worktrees);
      if (worktree === null) continue;
      if (input.liveWorktrees.has(worktree)) {
        out.skippedLive++;
        continue;
      }
      await cleanTranscript(path, input.now, out);
    }
  }
  const processes = input.processLines === undefined ? processTable() : input.processLines;
  if (processes === null) return out;
  const open = openPaths();
  for (const entry of list(input.tmp)) {
    if (!BROWSER_LEFTOVER.test(entry.name)) continue;
    const path = join(input.tmp, entry.name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || input.now - st.mtimeMs < BROWSER_LEFTOVER_AFTER_MS) continue;
    if (processes.some((line) => line.includes(path))) {
      out.skippedLive++;
      continue;
    }
    if (open === null || pathInUse(path, open)) {
      out.skippedLive++;
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      out.browserRemoved++;
    } catch {
      // Leave it for the next pass.
    }
  }
  return out;
}

/** Byte counts for the Machine panel. Operator projects and unrelated temp files are excluded. */
export async function crewLeftoverFootprint(
  input: Omit<CrewLeftoverInput, "now" | "liveWorktrees">,
): Promise<CrewLeftoverFootprint> {
  let claudeProjectsBytes = 0;
  for (const project of crewProjects(input.claudeProjects, input.worktrees)) {
    const paths: string[] = [];
    walkFiles(project, (path) => paths.push(path));
    for (const path of paths)
      if ((await transcriptWorktree(path, input.worktrees)) !== null)
        claudeProjectsBytes += bytes(path);
  }
  let codexSessionsBytes = 0;
  if (input.codexSessions !== undefined) {
    const paths: string[] = [];
    walkFiles(input.codexSessions, (path) => paths.push(path));
    for (const path of paths)
      if ((await transcriptWorktree(path, input.worktrees)) !== null)
        codexSessionsBytes += bytes(path);
  }
  let browserProfilesBytes = 0;
  let chromeTempBytes = 0;
  for (const entry of list(input.tmp)) {
    const path = join(input.tmp, entry.name);
    if (entry.name.startsWith("playwright_chromiumdev_profile-"))
      browserProfilesBytes += bytes(path);
    else if (entry.name.startsWith("com.google.Chrome.")) chromeTempBytes += bytes(path);
  }
  return {
    claudeProjectsBytes,
    codexSessionsBytes,
    browserProfilesBytes,
    chromeTempBytes,
    worktreesBytes: input.worktrees === undefined ? 0 : bytes(input.worktrees),
    previewsBytes: input.previews === undefined ? 0 : bytes(input.previews),
  };
}
