const CHECK_MS = 15_000;

/**
 * A preview hub exits when the process that started it is gone. Returns the interval so the hub
 * can clear it on shutdown, or undefined when the pid is not one to watch.
 */
export function watchPreviewParent(
  parentPid: number,
  exit: (code: number) => void = (code) => process.exit(code),
  alive: (pid: number) => void = (pid) => process.kill(pid, 0),
): NodeJS.Timeout | undefined {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) return undefined;
  const timer = setInterval(() => {
    try {
      alive(parentPid);
    } catch {
      exit(0);
    }
  }, CHECK_MS);
  timer.unref();
  return timer;
}
