import type { ChangeBus } from "../bus.ts";
import { type CcConfig, seatUnavailable } from "../config.ts";
import type { Store } from "../store.ts";
import { codexModels, type ModelDeps } from "./codex-models.ts";
import type { Supervisor } from "./supervisor.ts";

const DISCOVERY_RETRY_MS = 60_000;

/** Called only after HTTP is serving. Failures affect Codex seats, never the hub or Claude. */
export function startCodexDiscovery(deps: {
  config: CcConfig;
  bus: ChangeBus;
  store: Store;
  supervisor: Pick<Supervisor, "resumeRun">;
  models?: ModelDeps;
  retryMs?: number;
  log: (line: string) => void;
}): () => void {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const discover = async () => {
    try {
      await codexModels.load({ ...deps.models, signal: abort.signal });
      if (abort.signal.aborted) return;
      for (const row of deps.store.liveSeatRuns()) {
        const seat = deps.config.crew?.sessions
          .flatMap((s) => s.seats)
          .find((s) => s.id === row.seatId);
        if (
          seat &&
          row.run.vendor === "codex" &&
          !seatUnavailable(seat, row.run.model ?? undefined, row.run.vendor)
        ) {
          await deps.supervisor.resumeRun(row.run.id);
        }
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      deps.log(error instanceof Error ? error.message : "Codex discovery failed");
      timer = setTimeout(() => void discover(), deps.retryMs ?? DISCOVERY_RETRY_MS);
      timer.unref();
    } finally {
      if (!abort.signal.aborted) {
        deps.bus.emit("config");
        deps.bus.emit("agents");
      }
    }
  };
  void discover();
  return () => {
    clearTimeout(timer);
    abort.abort();
  };
}
