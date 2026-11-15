/** A private JSON-lines log that rotates without restarting the hub or its crew. */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const SERVER_LOG_BYTES = 20 * 1024 * 1024;
export const SERVER_LOG_ARCHIVES = 7;
interface LogOptions {
  bytes?: number;
  archives?: number;
  now?: () => number;
  fallback?: (line: string) => void;
}

export function rotatingLog(path: string, options: LogOptions = {}): { write(line: string): void } {
  const bytes = options.bytes ?? SERVER_LOG_BYTES;
  const archives = options.archives ?? SERVER_LOG_ARCHIVES;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(archives) || archives < 1)
    throw new Error("Log rotation needs positive integer byte and archive limits.");
  const now = options.now ?? Date.now;
  const fallback = options.fallback ?? ((line: string) => void process.stderr.write(line));
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  let writtenDay: string | undefined;
  let warned = false;
  return {
    write(line) {
      let fd: number | undefined;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const open = () => {
          const file = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            if (!fstatSync(file).isFile())
              throw new Error("Log destination is not a regular file.");
            fchmodSync(file, 0o600);
            return file;
          } catch (error) {
            closeSync(file);
            throw error;
          }
        };
        fd = open();
        const stat = fstatSync(fd);
        const today = day(now());
        writtenDay ??= day(stat.mtimeMs);
        // Keep a single oversized record whole; the following record starts a new file.
        if (
          stat.size > 0 &&
          (stat.size + Buffer.byteLength(line) > bytes || writtenDay !== today)
        ) {
          closeSync(fd);
          fd = undefined;
          rmSync(`${path}.${archives}`, { force: true });
          for (let n = archives - 1; n >= 1; n--) {
            try {
              renameSync(`${path}.${n}`, `${path}.${n + 1}`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          renameSync(path, `${path}.1`);
          fd = open();
        }
        writeFileSync(fd, line);
        writtenDay = today;
        warned = false;
      } catch {
        // Preserve the already-redacted record even if the log directory is unavailable.
        if (!warned) fallback("Mission Control: rotating log unavailable; using stderr.\n");
        warned = true;
        fallback(line);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}
