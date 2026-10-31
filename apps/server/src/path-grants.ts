import { approvedGrantPaths } from "@mc/core";
import type { Store } from "./store.ts";

const RUN_GRANT_KEY = (runId: string): string => `run-path-grant:${runId}`;

/** Files outside the seat's area that FLIGHT approved for this run alone; empty for every other run. */
export function runPathGrants(store: Pick<Store, "getSetting">, runId: string): string[] {
  const raw = store.getSetting(RUN_GRANT_KEY(runId));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Fixes the run's grant at its start; a ticket edited later does not change it. */
export function setRunPathGrants(
  store: Pick<Store, "setSetting">,
  runId: string,
  paths: readonly string[],
): void {
  if (paths.length > 0) store.setSetting(RUN_GRANT_KEY(runId), JSON.stringify(paths));
}

/** The paths FLIGHT's grant decisions for `ref` have approved. */
export function approvedPaths(store: Pick<Store, "flightDecisionsAbout">, ref: string): string[] {
  return store
    .flightDecisionsAbout("grant", ref)
    .flatMap((d) => approvedGrantPaths(ref, d.decision));
}
