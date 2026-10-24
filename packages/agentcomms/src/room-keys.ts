import { createHash } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readOptional, writePrivateOnce } from "./local-files.ts";

const prefix = (room: string) => `room-${createHash("sha256").update(room).digest("hex")}-`;
export async function readRoomKeys(home: string, room: string): Promise<Map<number, Uint8Array>> {
  const directory = join(home, "keys");
  const keys = new Map<number, Uint8Array>();
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return keys;
    throw error;
  }
  for (const file of files) {
    if (!file.startsWith(prefix(room))) continue;
    const match = /^(\d+)\.json$/.exec(file.slice(prefix(room).length));
    if (!match) continue;
    const epoch = Number(match[1]);
    const raw = await readOptional(join(directory, file));
    const encoded: unknown = JSON.parse(raw as string);
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      String(epoch) !== match[1] ||
      typeof encoded !== "string"
    )
      throw new Error("Invalid room key");
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded)
      throw new Error("Invalid room key");
    keys.set(epoch, key);
  }
  return keys;
}
export async function saveRoomKeys(
  home: string,
  room: string,
  keys: Map<number, Uint8Array>,
): Promise<void> {
  const directory = join(home, "keys");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Keys path must be a directory, not a symlink");
  for (const [epoch, key] of keys) {
    if (!Number.isSafeInteger(epoch) || epoch < 0 || key.length !== 32)
      throw new Error("Invalid room key");
    await writePrivateOnce(
      join(directory, `${prefix(room)}${epoch}.json`),
      JSON.stringify(Buffer.from(key).toString("base64url")),
    );
  }
}
