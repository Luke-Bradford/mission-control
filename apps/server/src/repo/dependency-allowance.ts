import type { AllowedPackage } from "@mc/core";
import { parseJson, rethrowJson } from "../json.ts";
import type { Store } from "../store.ts";

/** What FLIGHT allowed one run to add (`allow_dependency`), and what its commits have added. */
export interface DependencyAllowance {
  files: string[];
  packages: AllowedPackage[];
  /** Names of the allowed packages a commit has added to a manifest. */
  added: string[];
}

const KEY = (runId: string): string => `run-dependency:${runId}`;
const NONE: DependencyAllowance = { files: [], packages: [], added: [] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

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
    const packages = (Array.isArray(v.packages) ? v.packages : []).filter(
      (p): p is AllowedPackage =>
        typeof p === "object" &&
        p !== null &&
        typeof p.name === "string" &&
        typeof p.version === "string" &&
        typeof p.licence === "string",
    );
    return { files: strings(v.files), packages, added: strings(v.added) };
  } catch {
    return NONE;
  }
}

/** Adds to the run's allowance: a package named again takes the newer version and licence. */
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

/** Records packages a commit added, once each. */
export function markDependenciesAdded(
  store: Pick<Store, "getSetting" | "setSetting">,
  runId: string,
  names: readonly string[],
): void {
  const was = runDependencyAllowance(store, runId);
  const added = [...new Set([...was.added, ...names])];
  if (added.length === was.added.length) return;
  store.setSetting(KEY(runId), JSON.stringify({ ...was, added }));
}

/** The allowed packages the run's commits added, in the order FLIGHT named them. */
export function addedDependencies(
  store: Pick<Store, "getSetting">,
  runId: string,
): AllowedPackage[] {
  const a = runDependencyAllowance(store, runId);
  return a.packages.filter((p) => a.added.includes(p.name));
}
