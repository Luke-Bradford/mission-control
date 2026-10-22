/**
 * How long a signal waits for the crew, the scheduler and the server to stop before the process
 * exits anyway.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * The SIGINT/SIGTERM handler: stops the crew supervisor (its processes end; their runs stay active
 * for the next start to resume), then the scheduler, then closes the server, then exits 0. A stop
 * or close that hangs is cut off after SHUTDOWN_TIMEOUT_MS with a warning, so launchd never waits
 * on it. A second signal while shutting down is ignored.
 */
export function onSignal(i: {
  stopCrew: () => Promise<void>;
  stop: () => Promise<void>;
  close: () => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  exit: (code: number) => void;
}): (signal: string) => Promise<void> {
  let stopping = false;
  return async (signal) => {
    if (stopping) return;
    stopping = true;
    i.log.info(`${signal}: shutting down`);
    setTimeout(() => {
      i.log.warn(`${signal}: still stopping after ${SHUTDOWN_TIMEOUT_MS} ms; exiting`);
      i.exit(0);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    await i.stopCrew();
    await i.stop();
    await i.close();
    i.exit(0);
  };
}
