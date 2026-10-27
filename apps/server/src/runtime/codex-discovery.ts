import { codexProfile } from "../account-bindings.ts";
import type { ChangeBus } from "../bus.ts";
import { type CcConfig, seatUnavailable } from "../config.ts";
import type { Store } from "../store.ts";
import { codexModels, codexModelsFor, type ModelDeps } from "./codex-models.ts";
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
  const timers = new Set<NodeJS.Timeout>();
  const retry = (discover: () => Promise<void>) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void discover();
    }, deps.retryMs ?? DISCOVERY_RETRY_MS);
    timers.add(timer);
    timer.unref();
  };

  const resumeAvailableRuns = async () => {
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
  };

  // Seat availability has always been based on the machine login's catalog.  Profile catalogs
  // are for the setup picker, so a slow or unavailable profile must not hold up that catalog.
  const discoverMachine = async () => {
    try {
      await codexModels.load({ ...deps.models, signal: abort.signal });
      if (abort.signal.aborted) return;
      await resumeAvailableRuns();
    } catch (error) {
      if (abort.signal.aborted) return;
      deps.log(error instanceof Error ? error.message : "Codex discovery failed");
      retry(discoverMachine);
    } finally {
      if (!abort.signal.aborted) {
        deps.bus.emit("config");
        deps.bus.emit("agents");
      }
    }
  };

  const discoverProfile = async (account: CcConfig["accounts"][number]) => {
    try {
      await codexModelsFor(account).load({
        ...deps.models,
        authPath: `${codexProfile(account)}/auth.json`,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      await resumeAvailableRuns();
    } catch (error) {
      if (abort.signal.aborted) return;
      deps.log(error instanceof Error ? error.message : "Codex discovery failed");
      retry(() => discoverProfile(account));
    } finally {
      if (!abort.signal.aborted) deps.bus.emit("config");
    }
  };

  void discoverMachine();
  for (const account of deps.config.accounts) {
    if (account.vendor === "codex" && account.cliProfile !== undefined)
      void discoverProfile(account);
  }
  return () => {
    for (const timer of timers) clearTimeout(timer);
    abort.abort();
  };
}
