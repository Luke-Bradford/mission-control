import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Directory, verifyDirectory } from "./auth.ts";
import { canonicalJson } from "./canonical.ts";
import { readOptional, writePrivateOnce } from "./local-files.ts";
import type { Invite } from "./membership.ts";
import { directorySchema } from "./protocol.ts";
import { validateMember } from "./relay-core.ts";

const path = (home: string, room: string) =>
  join(home, "trust", createHash("sha256").update(room).digest("hex"));
export function checkedDirectory(
  value: unknown,
  invite: Pick<Invite, "room" | "ownerId">,
): Directory {
  const { t: _, ...record } = value as Record<string, unknown>;
  const d = directorySchema.parse(record);
  if (!verifyDirectory(d, invite.room, invite.ownerId))
    throw new Error("Invalid owner-signed directory");
  const ids = new Set<string>();
  for (const member of d.members) {
    validateMember(member);
    for (const id of [member.id, ...member.agents.map((a) => a.id)]) {
      if (ids.has(id)) throw new Error("Duplicate directory identity");
      ids.add(id);
    }
  }
  return d;
}
async function storedVersions(home: string, room: string): Promise<string[]> {
  try {
    return (await readdir(path(home, room)))
      .filter((file) => /^\d+\.json$/.test(file))
      .sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function storedDirectory(
  home: string,
  invite: Pick<Invite, "room" | "ownerId">,
  file: string,
): Promise<Directory> {
  const raw = await readOptional(join(path(home, invite.room), file));
  const directory = checkedDirectory(JSON.parse(raw as string), invite);
  if (`${directory.version}.json` !== file) throw new Error("Invalid stored directory version");
  return directory;
}
export async function readTrust(
  home: string,
  invite: Pick<Invite, "room" | "ownerId">,
): Promise<Directory | undefined> {
  const [latest] = await storedVersions(home, invite.room);
  return latest ? storedDirectory(home, invite, latest) : undefined;
}
export async function readMembershipTrust(
  home: string,
  invite: Pick<Invite, "room" | "ownerId">,
  memberId: string,
): Promise<{ directory: Directory | undefined; removed: boolean }> {
  const [latest, ...history] = await storedVersions(home, invite.room);
  const directory = latest ? await storedDirectory(home, invite, latest) : undefined;
  if (directory && !directory.activeMemberIds.includes(memberId)) {
    for (const file of history) {
      const previous = await storedDirectory(home, invite, file);
      if (previous.activeMemberIds.includes(memberId)) return { directory, removed: true };
    }
  }
  return { directory, removed: false };
}
export async function acceptDirectory(
  home: string,
  invite: Pick<Invite, "room" | "ownerId">,
  value: unknown,
  previous?: Directory,
): Promise<Directory> {
  const d = checkedDirectory(value, invite);
  const saved = await readTrust(home, invite);
  const old = saved && (!previous || saved.version > previous.version) ? saved : previous;
  if (old) {
    if (d.version < old.version || d.keyEpoch < old.keyEpoch) return old;
    if (d.version === old.version) {
      if (canonicalJson(d) !== canonicalJson(old)) throw new Error("Conflicting signed directory");
      return old;
    }
  }
  await writePrivateOnce(join(path(home, invite.room), `${d.version}.json`), JSON.stringify(d));
  // An overlapping owner/daemon write may already have published a newer version.
  return (await readTrust(home, invite)) ?? d;
}
