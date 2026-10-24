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
export async function readTrust(
  home: string,
  invite: Pick<Invite, "room" | "ownerId">,
): Promise<Directory | undefined> {
  let files: string[];
  try {
    files = await readdir(path(home, invite.room));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const versions = files
    .filter((file) => /^\d+\.json$/.test(file))
    .sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));
  if (!versions.length) return undefined;
  const raw = await readOptional(join(path(home, invite.room), versions[0]));
  const directory = checkedDirectory(JSON.parse(raw as string), invite);
  if (`${directory.version}.json` !== versions[0])
    throw new Error("Invalid stored directory version");
  return directory;
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
