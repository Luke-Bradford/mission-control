/**
 * The server's one write to its own config: appending a repo to config.yaml (#26 A8). The path is
 * the one the server started with; no request names a path, and a symbolic link there is refused.
 * Every write re-reads the file, keeps its comments and key order (the YAML Document API, never
 * string concatenation; other spacing and quoting may be normalised), re-validates the whole result
 * with the startup loader, keeps a backup beside it, and swaps the file in by an atomic rename.
 */
import { type FileHandle, lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compactUtc, type NewRepo } from "@mc/core";
import { isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { type CcConfig, parseConfig, ticketState } from "./config.ts";

/** Backups (`config.yaml.bak-<UTC>`) kept beside the file; older ones are deleted. */
export const CONFIG_BACKUPS_KEEP = 10;

/** A GitHub `owner/name`: owner 1–39 of [A-Za-z0-9-] not starting with `-`, name 1–100. */
const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CONTROL_CHAR = /\p{Cc}/u;
const MAX_STATUS_ENTRIES = 50;

/** Where a repo's board lives on GitHub; shared by every route that takes a repo to add. */
export const RepoLocation = z.strictObject({
  github: z.string().regex(GITHUB_REPO, "must be owner/name"),
  project: z.number().int().min(1).max(1_000_000),
});

/** `POST /api/repos`. */
export const NewRepoBody = z.strictObject({
  id: z.string().regex(REPO_ID, "must be 1–40 letters, digits, . _ or -, starting alphanumeric"),
  ...RepoLocation.shape,
  statusMap: z
    .record(
      z
        .string()
        .min(1)
        .max(100)
        .refine((k) => !CONTROL_CHAR.test(k), "must not contain control characters"),
      ticketState,
    )
    .refine(
      (m) => Object.keys(m).length >= 1 && Object.keys(m).length <= MAX_STATUS_ENTRIES,
      `must have 1–${MAX_STATUS_ENTRIES} entries`,
    ),
  needsYouLabels: z.array(z.string().min(1).max(50)).max(10).optional(),
});

export type ConfigWriteKind = "current" | "duplicate" | "write";

/**
 * Why a config write did not happen. `current`: the file on disk does not load (nothing written);
 * `duplicate`: the repo is already configured; `write`: the backup or swap failed (the file is
 * unchanged). The message never carries file contents.
 */
export class ConfigWriteError extends Error {
  readonly kind: ConfigWriteKind;
  constructor(kind: ConfigWriteKind, message: string) {
    super(message);
    this.name = "ConfigWriteError";
    this.kind = kind;
  }
}

type ConfigRepo = CcConfig["repos"][number];

/** Why `repo` is already in `repos` (same id, or same github in any case with the same project), or null. */
export function duplicateReason(repos: readonly ConfigRepo[], repo: NewRepo): string | null {
  if (repos.some((r) => r.id === repo.id))
    return `a repo with id "${repo.id}" is already configured`;
  const github = repo.github.toLowerCase();
  if (repos.some((r) => r.github.toLowerCase() === github && r.project === repo.project)) {
    return `${repo.github} project ${repo.project} is already configured`;
  }
  return null;
}

/** The part after `.bak-` in a backup this module names: the stamp and a same-second counter. */
const BACKUP_SUFFIX = /^(\d{8}T\d{6}Z)(?:-(\d+))?$/;
const MAX_SAME_SECOND = 100;

const errCode = (e: unknown): string => String((e as NodeJS.ErrnoException | null)?.code ?? "?");

// Writers run one at a time, so two Add clicks never read the same file and lose one repo.
let queue: Promise<unknown> = Promise.resolve();

/** Appends `repo` to the config.yaml at `path`; resolves with the new config and the backup's path. */
export function addRepo(
  path: string,
  repo: NewRepo,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const run = queue.then(() => add(path, repo, now));
  queue = run.catch(() => undefined);
  return run;
}

async function add(
  path: string,
  repo: NewRepo,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  // 1. The file as it is now, which may have been edited by hand since the server started. A link
  // would make the backup and the write land somewhere other than the file named by the path.
  let isLink: boolean;
  try {
    isLink = (await lstat(path)).isSymbolicLink();
  } catch {
    throw new ConfigWriteError("current", "the current config.yaml does not load");
  }
  if (isLink) throw new ConfigWriteError("current", "config.yaml is a symbolic link");
  let bytes: Buffer;
  let text: string;
  let current: CcConfig;
  try {
    bytes = await readFile(path);
    text = bytes.toString("utf8");
    current = parseConfig(text, "config.yaml");
  } catch {
    throw new ConfigWriteError("current", "the current config.yaml does not load");
  }
  // 2.
  const duplicate = duplicateReason(current.repos, repo);
  if (duplicate) throw new ConfigWriteError("duplicate", duplicate);

  // 3. Append through the YAML Document, which keeps comments and key order.
  const doc = parseDocument(text);
  const repos = doc.get("repos", true);
  if (doc.errors.length > 0 || !isSeq(repos)) {
    throw new ConfigWriteError("current", "config.yaml has no repos list to append to");
  }
  const entry = doc.createNode(
    {
      id: repo.id,
      github: repo.github,
      project: repo.project,
      status_map: repo.statusMap,
      ...(repo.needsYouLabels === undefined ? {} : { needs_you_labels: repo.needsYouLabels }),
    },
    { aliasDuplicateObjects: false },
  );
  if (repos.items.length === 0) {
    // `repos: []` is a flow sequence; a fresh one is written as a block list, keeping its comments.
    const list = doc.createNode([entry]);
    list.commentBefore = repos.commentBefore;
    list.comment = repos.comment;
    doc.set("repos", list);
  } else {
    repos.add(entry);
  }
  const newText = doc.toString({ lineWidth: 0 }); // 0: never fold a long line
  const added: ConfigRepo = {
    id: repo.id,
    github: repo.github,
    project: repo.project,
    statusMap: repo.statusMap,
    ...(repo.needsYouLabels === undefined ? {} : { needsYouLabels: repo.needsYouLabels }),
    fullSuite: [],
    autonomy: "draft",
  };
  let next: CcConfig;
  try {
    next = parseConfig(newText, "the new config.yaml");
  } catch {
    throw new ConfigWriteError("write", "the new config.yaml would not load");
  }
  if (!isDeepStrictEqual(next, { ...current, repos: [...current.repos, added] })) {
    throw new ConfigWriteError(
      "write",
      "the new config.yaml would change more than the added repo",
    );
  }

  // 4. Keep the old file beside the new one: the bytes read and validated above.
  const backup = await backUp(path, bytes, now);
  // 5.
  await replace(path, newText);
  // Old backups are spare copies: failing to delete one must not fail an add that has landed.
  await pruneBackups(path, basename(backup)).catch(() => undefined);
  return { config: next, backup };
}

/**
 * Writes `bytes` to a new `<path>.bak-<UTC>` (a counter when that second is taken), created 0600
 * and exclusively, so it is never readable more widely and never overwrites an earlier backup.
 */
async function backUp(path: string, bytes: Buffer, now: number): Promise<string> {
  const stamp = compactUtc(now);
  for (let n = 0; n < MAX_SAME_SECOND; n++) {
    const backup = `${path}.bak-${stamp}${n === 0 ? "" : `-${n}`}`;
    let file: FileHandle;
    try {
      file = await open(backup, "wx", 0o600);
    } catch (e) {
      if (errCode(e) === "EEXIST") continue;
      throw new ConfigWriteError("write", `could not back up config.yaml (${errCode(e)})`);
    }
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (e) {
      await rm(backup, { force: true }).catch(() => undefined);
      throw new ConfigWriteError("write", `could not back up config.yaml (${errCode(e)})`);
    }
    return backup;
  }
  throw new ConfigWriteError("write", "could not back up config.yaml (no free backup name)");
}

/** Writes a temp file beside `path` (0600, fsynced) and renames it over `path`; never half-written. */
async function replace(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await rm(tmp, { force: true }); // a temp file left by a crashed process with this pid
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new ConfigWriteError("write", `could not replace config.yaml (${errCode(e)})`);
  }
}

/**
 * Deletes all but CONFIG_BACKUPS_KEEP backups this module named, no other file: `keep` (this add's
 * own backup, whatever its stamp says, since the clock may have gone back) and the newest others.
 */
async function pruneBackups(path: string, keep: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  const ours = (await readdir(dir)).flatMap((name) => {
    if (name === keep) return [];
    const m = name.startsWith(prefix) ? BACKUP_SUFFIX.exec(name.slice(prefix.length)) : null;
    return m?.[1] ? [{ name, stamp: m[1], n: Number(m[2] ?? 0) }] : [];
  });
  // newest first: by stamp, then by same-second counter
  ours.sort((a, b) => (a.stamp === b.stamp ? b.n - a.n : a.stamp < b.stamp ? 1 : -1));
  for (const old of ours.slice(CONFIG_BACKUPS_KEEP - 1)) {
    await rm(join(dir, old.name), { force: true });
  }
}
