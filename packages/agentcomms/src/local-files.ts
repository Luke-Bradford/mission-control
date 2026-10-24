import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
