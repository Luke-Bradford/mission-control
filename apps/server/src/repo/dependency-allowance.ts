import type { AllowedPackage } from "@mc/core";
import { parseJson, rethrowJson } from "../json.ts";
import type { Store } from "../store.ts";

/** What FLIGHT allowed one run to add (`allow_dependency`), and what its commits have added. */
export interface DependencyAllowance {
  files: string[];
  packages: AllowedPackage[];
  /**
   * Each package a commit added, as it was allowed when that commit was made: a later allowance
   * of the same name does not change it. The PR's Added dependencies section lists these.
   */
  added: AllowedPackage[];
}

const KEY = (runId: string): string => `run-dependency:${runId}`;
const NONE: DependencyAllowance = { files: [], packages: [], added: [] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const packagesOf = (v: unknown): AllowedPackage[] =>
  (Array.isArray(v) ? v : []).filter(
    (p): p is AllowedPackage =>
      typeof p === "object" &&
      p !== null &&
      typeof p.name === "string" &&
      typeof p.version === "string" &&
      typeof p.licence === "string",
  );

/** The run's allowance; empty for a run FLIGHT allowed nothing. */
export function runDependencyAllowance(
  store: Pick<Store, "getSetting">,
  runId: string,
): DependencyAllowance {
  const raw = store.getSetting(KEY(runId));
  if (raw === null) return NONE;
  try {
    const v = parseJson<unknown>(raw, undefined, rethrowJson) as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null) return NONE;
    return {
      files: strings(v.files),
      packages: packagesOf(v.packages),
      added: packagesOf(v.added),
    };
  } catch {
    return NONE;
  }
}

/**
 * Adds to the run's allowance: a package named again takes the newer version and licence for
 * commits from now on. What a commit already added keeps its record.
 */
export function allowRunDependencies(
  store: Pick<Store, "getSetting" | "setSetting">,
  runId: string,
  files: readonly string[],
  packages: readonly AllowedPackage[],
): void {
  const was = runDependencyAllowance(store, runId);
  const kept = was.packages.filter((p) => !packages.some((q) => q.name === p.name));
  const next: DependencyAllowance = {
    files: [...new Set([...was.files, ...files])],
    packages: [...kept, ...packages],
    added: was.added,
  };
  store.setSetting(KEY(runId), JSON.stringify(next));
}

/** Records the packages a commit added, as allowed then; a name already recorded keeps its record. */
export function markDependenciesAdded(
  store: Pick<Store, "getSetting" | "setSetting">,
  runId: string,
  packages: readonly AllowedPackage[],
): void {
  const was = runDependencyAllowance(store, runId);
  const added = [...was.added];
  for (const p of packages) {
    if (!added.some((a) => a.name === p.name)) {
      added.push({ name: p.name, version: p.version, licence: p.licence });
    }
  }
  if (added.length === was.added.length) return;
  store.setSetting(KEY(runId), JSON.stringify({ ...was, added }));
}

/** The packages the run's commits added, in the order they were committed. */
export function addedDependencies(
  store: Pick<Store, "getSetting">,
  runId: string,
): AllowedPackage[] {
  return runDependencyAllowance(store, runId).added;
}
