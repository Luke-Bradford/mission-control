/**
 * Setup › Hub: reads and writes the hub-wide settings in config.yaml. A write follows `setRoles`:
 * one at a time, against the digest the page read, with a backup and a check that the new file loads.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  HUB_SETTINGS,
  type HubSettingDef,
  type HubSettingKey,
  type HubSettingsView,
  isHubSettingKey,
} from "@mc/core";
import { isMap, isSeq, parseDocument } from "yaml";
import { type CcConfig, findHubRoot, parseConfig } from "../config.ts";
import {
  backUp,
  ConfigWriteError,
  enqueueWrite,
  pruneBackups,
  REPO_ROLES_CHANGED,
  readCurrent,
  replace,
  repoRolesHash,
} from "./config-write.ts";

export const CREW_FIRST_TEXT = "set the crew folder first";
export const repoInUseText = (id: string, users: string[]): string =>
  `${id} is in use by ${users.join(", ")}; close or remove those first`;
export const starterLogText = (path: string): string => `wrote a starter config at ${path}`;

const REPO_KEYS = ["repo.status_map", "repo.autonomy", "repo.flight_powers"] as const;
const isRepoKey = (key: HubSettingKey): boolean => key.startsWith("repo.");
const pathOf = (key: HubSettingKey): string[] => key.split(".");
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function dig(root: unknown, path: string[]): unknown {
  let at = root;
  for (const part of path) {
    if (!isObject(at)) return undefined;
    at = at[part];
  }
  return at;
}

/** Why `value` does not fit `def`, or null. The file's own schema then judges the range. */
function kindProblem(def: HubSettingDef, value: unknown): string | null {
  switch (def.kind) {
    case "text":
      return typeof value === "string" && value.trim() !== "" ? null : "must be text";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
    case "bool":
      return typeof value === "boolean" ? null : "must be true or false";
    case "choice":
      return typeof value === "string" && def.choices?.includes(value)
        ? null
        : `must be one of ${def.choices?.join(", ")}`;
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() !== "")
        ? null
        : "must be a list of text";
    case "map":
      return isObject(value) && Object.values(value).every((v) => typeof v === "string")
        ? null
        : "must map names to text";
  }
}

export async function readHubSettings(path: string): Promise<HubSettingsView> {
  const { bytes, text } = await readCurrent(path);
  const raw = parseDocument(text).toJS() as unknown;
  const values: HubSettingsView["values"] = {};
  const repos: HubSettingsView["repos"] = {};
  for (const key of Object.keys(HUB_SETTINGS) as HubSettingKey[]) {
    if (isRepoKey(key)) continue;
    const found = dig(raw, pathOf(key));
    if (found !== undefined) values[key] = found;
  }
  const rawRepos = isObject(raw) && Array.isArray(raw.repos) ? raw.repos : [];
  for (const repo of rawRepos) {
    if (!isObject(repo) || typeof repo.id !== "string") continue;
    const own: Partial<Record<HubSettingKey, unknown>> = {};
    for (const key of REPO_KEYS) {
      const found = repo[key.slice("repo.".length)];
      if (found !== undefined) own[key] = found;
    }
    repos[repo.id] = own;
  }
  return { base: repoRolesHash(bytes), values, repos };
}

export function setHubSetting(
  path: string,
  base: string,
  key: HubSettingKey,
  value: unknown,
  now: number,
  repoId?: string,
): Promise<{ config: CcConfig; backup: string }> {
  return enqueueWrite(async () => {
    if (!isHubSettingKey(key)) throw new ConfigWriteError("invalid", "unknown setting");
    const def = HUB_SETTINGS[key];
    if (value !== null) {
      const problem = kindProblem(def, value);
      if (problem) throw new ConfigWriteError("invalid", `${def.label} ${problem}`);
    }
    if (isRepoKey(key) !== (repoId !== undefined))
      throw new ConfigWriteError(
        "invalid",
        `${def.label} ${repoId ? "is not" : "is"} a repo setting`,
      );
    const { bytes, text, current } = await readCurrent(path);
    if (repoRolesHash(bytes) !== base) throw new ConfigWriteError("conflict", REPO_ROLES_CHANGED);
    const doc = parseDocument(text);
    const target: (string | number)[] = pathOf(key);
    if (repoId !== undefined) {
      const index = current.repos.findIndex((r) => r.id === repoId);
      if (index < 0) throw new ConfigWriteError("missing", `unknown repo ${repoId}`);
      target.splice(0, 1, "repos", index);
    } else if (target[0] === "crew" && !isMap(doc.get("crew", true))) {
      if (key !== "crew.worktrees") throw new ConfigWriteError("invalid", CREW_FIRST_TEXT);
      doc.set("crew", doc.createNode({ worktrees: value, sessions: [] }));
      return commit(path, doc, bytes, now);
    }
    if (value === null) doc.deleteIn(target);
    else doc.setIn(target, doc.createNode(value));
    return commit(path, doc, bytes, now);
  });
}

async function commit(
  path: string,
  doc: ReturnType<typeof parseDocument>,
  bytes: Buffer,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const newText = doc.toString({ lineWidth: 0 });
  let next: CcConfig;
  try {
    next = parseConfig(newText, "config.yaml", { hubRoot: findHubRoot(), deferModels: true });
  } catch (e) {
    throw new ConfigWriteError("invalid", e instanceof Error ? e.message : "invalid config");
  }
  const backup = await backUp(path, bytes, now);
  await replace(path, newText);
  await pruneBackups(path, basename(backup)).catch(() => undefined);
  return { config: next, backup };
}

/** Takes a repo out of config.yaml; refused while a loop or crew session still uses it. */
export function removeRepo(
  path: string,
  repoId: string,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  return enqueueWrite(async () => {
    const { bytes, text, current } = await readCurrent(path);
    const index = current.repos.findIndex((r) => r.id === repoId);
    if (index < 0) throw new ConfigWriteError("missing", `unknown repo ${repoId}`);
    const users = [
      ...current.loops.filter((l) => l.repoId === repoId).map((l) => `loop ${l.id}`),
      ...(current.crew?.sessions ?? [])
        .filter((s) => s.repoId === repoId)
        .map((s) => `session ${s.id}`),
    ];
    if (users.length > 0) throw new ConfigWriteError("conflict", repoInUseText(repoId, users));
    const doc = parseDocument(text);
    if (!isSeq(doc.get("repos", true)))
      throw new ConfigWriteError("current", "config.yaml has no repo list");
    doc.deleteIn(["repos", index]);
    return commit(path, doc, bytes, now);
  });
}

/** Writes a starter config when `path` is missing; true when it did. An existing file is untouched. */
export function ensureConfigFile(path: string, timezone: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const text = `# Written on first start; edit it on Setup in the app.\noperator:\n  timezone: ${JSON.stringify(timezone)}\naccounts: []\nrepos: []\nloops: []\npoll:\n  usage_minutes: 30\n  github_seconds: 60\n`;
  try {
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  return true;
}
