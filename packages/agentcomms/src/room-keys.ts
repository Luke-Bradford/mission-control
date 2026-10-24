import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readOptional, writePrivate } from "./local-files.ts";

function keyPath(home: string, room: string): string {
  return join(home, "keys", `room-${createHash("sha256").update(room).digest("hex")}.json`);
}

export async function readRoomKeys(home: string, room: string): Promise<Map<number, Uint8Array>> {
  const raw = await readOptional(keyPath(home, room));
  const keys = new Map<number, Uint8Array>();
  if (raw === undefined) return keys;
  const stored: unknown = JSON.parse(raw);
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    throw new Error("Invalid room keys");
  for (const [epoch, encoded] of Object.entries(stored)) {
    const number = Number(epoch);
    if (
      !Number.isSafeInteger(number) ||
      number < 0 ||
      String(number) !== epoch ||
      typeof encoded !== "string"
    )
      throw new Error("Invalid room keys");
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded)
      throw new Error("Invalid room key");
    keys.set(number, key);
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
  const stored = Object.fromEntries(
    [...keys].map(([epoch, key]) => {
      if (!Number.isSafeInteger(epoch) || epoch < 0 || key.length !== 32)
        throw new Error("Invalid room key");
      return [epoch, Buffer.from(key).toString("base64url")];
    }),
  );
  await writePrivate(keyPath(home, room), JSON.stringify(stored));
}
