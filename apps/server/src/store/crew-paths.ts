import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** `stray:` + the first 16 hex characters of SHA-256 of `session\0path`: one item per path. */
export function strayKey(sessionId: string, path: string): string {
  return `stray:${createHash("sha256").update(`${sessionId}\0${path}`).digest("hex").slice(0, 16)}`;
}

/** `{dir of the DB}/crew/`: every crew run's files. Created with mode 0700. */
export function crewDir(dbPath: string): string {
  const dir = crewDirPath(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Where `crewDir` is, without making it. */
export function crewDirPath(dbPath: string): string {
  return join(dirname(dbPath), "crew");
}

/** A crew run's transcript: `{dir of the DB}/crew/{runId}.jsonl`. */
export function crewTranscriptPath(dbPath: string, runId: string): string {
  return join(crewDir(dbPath), `${runId}.jsonl`);
}

/** A crew run's system prompt file (role brief + the repo's CLAUDE.md), beside its transcript. */
export function crewPromptPath(dbPath: string, runId: string): string {
  return join(dirname(crewTranscriptPath(dbPath, runId)), `${runId}.prompt.md`);
}

/**
 * A crew run's token file, beside its transcript: what the guard hook reads its token from. The
 * supervisor writes it at 0600 for the run's process and removes it when that process exits; the
 * sandbox read-denies the whole directory.
 */
export function crewTokenPath(dbPath: string, runId: string): string {
  return join(dirname(crewTranscriptPath(dbPath, runId)), `${runId}.token`);
}

/** A crew run's `--mcp-config` file (it holds the token too): written and removed with it. */
export function crewMcpPath(dbPath: string, runId: string): string {
  return join(dirname(crewTranscriptPath(dbPath, runId)), `${runId}.mcp.json`);
}

/** A draft PR's body file (`pr-<uuid>.md` in `{DB dir}/crew/`), which `gh pr create` reads. */
export const CREW_PR_BODY_FILE =
  /^pr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

/** A new, unique path for a draft PR's body file; the tool removes it once gh has read it. */
export function crewPrBodyPath(dbPath: string): string {
  return join(crewDir(dbPath), `pr-${randomUUID()}.md`);
}

/** A crew run's keeper folder: `{dir of the DB}/crew/k-<12 hex of sha256(runId)>`, short for its socket path. */
export function crewKeeperDir(dbPath: string, runId: string): string {
  crewDir(dbPath);
  return crewKeeperDirPath(dbPath, runId);
}

/** Where `crewKeeperDir` is, without making `crew/`. */
export function crewKeeperDirPath(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDirPath(dbPath), `k-${hex}`);
}

/** Codex thread storage survives replacement of the run's keeper. */
export function crewCodexDir(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDir(dbPath), `codex-${hex}`);
}

export const CREW_CODEX_DIR = /^codex-[0-9a-f]{12}$/;

/**
 * A Claude run's skills plugin folder (`--plugin-dir`), built by the hub from the repo's commit. It
 * sits in the data dir, which the seat's sandbox cannot write, and is removed with the run's files.
 */
export function crewSkillsDir(dbPath: string, runId: string): string {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return join(crewDir(dbPath), `skills-${hex}`);
}

export const CREW_SKILLS_DIR = /^skills-[0-9a-f]{12}$/;

/** A keeper folder's name in `{DB dir}/crew/`. */
export const CREW_KEEPER_DIR = /^k-[0-9a-f]{12}$/;
