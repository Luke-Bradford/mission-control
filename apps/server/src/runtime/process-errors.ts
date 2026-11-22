/**
 * Records otherwise unhandled async and synchronous failures without taking down the hub.
 * Node keeps running when these listeners are installed, so this is the final safety net rather
 * than a replacement for handling errors at their source.
 */
export function installHubErrorHandlers(log: (line: string) => void): () => void {
  const write = (kind: string, error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      log(`hub ${kind}: ${message}`);
    } catch {
      // The logger must not turn an already unhandled error into another one.
    }
  };
  const rejection = (reason: unknown) => write("unhandled rejection", reason);
  const exception = (error: Error) => write("uncaught exception", error);
  process.on("unhandledRejection", rejection);
  process.on("uncaughtException", exception);
  return () => {
    process.off("unhandledRejection", rejection);
    process.off("uncaughtException", exception);
  };
}
