import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export type RestoreOperation = "restore" | "delete";

/** The caller confines this process with Seatbelt; these checks only give earlier refusals. */
export function mutateRestore(path: string, mode: string, operation: RestoreOperation): void {
  const parent = dirname(path);
  const name = basename(path);
  if (operation === "restore") fs.mkdirSync(parent, { recursive: true });
  process.chdir(parent);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (stat && !stat.isFile()) throw new Error("path is not a regular file");
  if (operation === "delete") {
    if (!stat) throw new Error("path is absent from the review head and worktree");
    fs.unlinkSync(name);
    return;
  }
  const body = fs.readFileSync(0);
  const temp = `.mc-restore-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, Number.parseInt(mode, 8));
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, name);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [path, mode, operation] = process.argv.slice(2);
    if (!path || (operation !== "restore" && operation !== "delete")) {
      throw new Error("invalid restore operation");
    }
    if (operation === "restore" && mode !== "100644" && mode !== "100755") {
      throw new Error("invalid restore mode");
    }
    mutateRestore(path, mode, operation);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
