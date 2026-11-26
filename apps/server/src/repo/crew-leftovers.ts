/**
 * Files created by crew tools outside the hub data folder. Every path is narrowed to a configured
 * crew worktree or to the two Chromium names before it is read or removed.
 */
import { execFileSync } from "node:child_process";
import {
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const CREW_TRANSCRIPT_GZIP_AFTER_MS = 24 * 60 * 60_000;
export const CREW_TRANSCRIPT_DELETE_AFTER_MS = 14 * 24 * 60 * 60_000;
export const BROWSER_LEFTOVER_AFTER_MS = 6 * 60 * 60_000;

const TRANSCRIPT = /\.jsonl(?:\.gz)?$/;
const BROWSER_LEFTOVER = /^(?:playwright_chromiumdev_profile-|com\.google\.Chrome\.)/;

export interface CrewLeftoverInput {
  now: number;
  worktrees: string | undefined;
  claudeProjects: string;
  codexSessions?: string;
  tmp: string;
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
const transcriptWorktree = (path: string, worktrees: string | undefined): string | null => {
  if (worktrees === undefined) return null;
  let text: Buffer;
  try {
    const input = readFileSync(path);
    text = path.endsWith(".gz") ? gunzipSync(input) : input;
  } catch {
    return null;
  }
  const start = text.toString("utf8", 0, 65_536);
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

const cleanTranscript = (path: string, now: number, out: CrewLeftoverResult): void => {
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
      writeFileSync(compressed, gzipSync(readFileSync(path)), { flag: "wx", mode: 0o600 });
      utimesSync(compressed, st.atime, st.mtime);
      rmSync(path, { force: true });
      out.gzipped++;
    }
  } catch {
    // The next hourly pass retries a file that another process changed or removed.
  }
};

/** Cleans only crew Claude projects and abandoned Chromium temporary entries. */
export function cleanupCrewLeftovers(input: CrewLeftoverInput): CrewLeftoverResult {
  const out: CrewLeftoverResult = { gzipped: 0, deleted: 0, browserRemoved: 0, skippedLive: 0 };
  const liveProjects = new Set([...input.liveWorktrees].map(crewProjectName));
  for (const project of crewProjects(input.claudeProjects, input.worktrees)) {
    if (liveProjects.has(project.slice(input.claudeProjects.length + 1))) {
      out.skippedLive++;
      continue;
    }
    walkFiles(project, (path) => {
      if (transcriptWorktree(path, input.worktrees) === null) return;
      cleanTranscript(path, input.now, out);
    });
  }
  if (input.codexSessions !== undefined)
    walkFiles(input.codexSessions, (path) => {
      const worktree = transcriptWorktree(path, input.worktrees);
      if (worktree === null) return;
      if (input.liveWorktrees.has(worktree)) {
        out.skippedLive++;
        return;
      }
      cleanTranscript(path, input.now, out);
    });
  const processes = input.processLines === undefined ? processTable() : input.processLines;
  if (processes === null) return out;
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
export function crewLeftoverFootprint(
  input: Omit<CrewLeftoverInput, "now" | "liveWorktrees">,
): CrewLeftoverFootprint {
  let claudeProjectsBytes = 0;
  for (const project of crewProjects(input.claudeProjects, input.worktrees))
    walkFiles(project, (path) => {
      if (transcriptWorktree(path, input.worktrees) !== null) claudeProjectsBytes += bytes(path);
    });
  let codexSessionsBytes = 0;
  if (input.codexSessions !== undefined)
    walkFiles(input.codexSessions, (path) => {
      if (transcriptWorktree(path, input.worktrees) !== null) codexSessionsBytes += bytes(path);
    });
  let browserProfilesBytes = 0;
  let chromeTempBytes = 0;
  for (const entry of list(input.tmp)) {
    const path = join(input.tmp, entry.name);
    if (entry.name.startsWith("playwright_chromiumdev_profile-"))
      browserProfilesBytes += bytes(path);
    else if (entry.name.startsWith("com.google.Chrome.")) chromeTempBytes += bytes(path);
  }
  return { claudeProjectsBytes, codexSessionsBytes, browserProfilesBytes, chromeTempBytes };
}
