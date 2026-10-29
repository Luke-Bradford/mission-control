import { existsSync, type Stats, statSync } from "node:fs";

/**
 * The files a memoised view read while it was built, with what each looked like then. A view is
 * reused only while every one still looks the same, so a transcript that grew or a sentinel that
 * appeared is seen at once, whatever the store's version says.
 */
export type FileDeps = Map<string, string>;

const SEP = "\0";
let collecting: FileDeps | null = null;

/** Whether the file looks as it did: its size and mtime (`stat`), or just that it exists (`exists`). */
function look(kind: "stat" | "exists", path: string): string {
  if (kind === "exists") return existsSync(path) ? "yes" : "no";
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** Notes that the build under way read `path` and saw `seen`; the first look is the one kept. */
export function noteFile(kind: "stat" | "exists", path: string, seen: string): void {
  collecting?.set(`${kind}${SEP}${path}`, collecting.get(`${kind}${SEP}${path}`) ?? seen);
}

/** `existsSync`, noted for the view being built. */
export function existsNoted(path: string): boolean {
  const found = existsSync(path);
  noteFile("exists", path, found ? "yes" : "no");
  return found;
}

/** `statSync` of a path, noted for the view being built; throws as `statSync` does. */
export function statNoted(path: string): Stats {
  try {
    const s = statSync(path);
    noteFile("stat", path, `${s.size}:${s.mtimeMs}`);
    return s;
  } catch (e) {
    noteFile("stat", path, "missing");
    throw e;
  }
}

/** Runs `build`, returning what it returned and the files it read. */
export function collectFiles<T>(build: () => T): { value: T; files: FileDeps } {
  const outer = collecting;
  const files: FileDeps = new Map();
  collecting = files;
  try {
    return { value: build(), files };
  } finally {
    collecting = outer;
    // a view built inside another is a dependency of it
    if (outer) for (const [k, v] of files) if (!outer.has(k)) outer.set(k, v);
  }
}

/** Whether every file in `files` still looks as it did. */
export function filesUnchanged(files: FileDeps): boolean {
  for (const [key, seen] of files) {
    const [kind, path] = key.split(SEP) as ["stat" | "exists", string];
    if (look(kind, path) !== seen) return false;
  }
  return true;
}
