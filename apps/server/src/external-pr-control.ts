/** Head-bound operator evidence for PRs with no crew author run. */
import type { Store } from "./store.ts";

export interface ExternalPrControl {
  since: number;
  uatRequired: boolean;
  uatAccepted: boolean;
  controllerRequired: boolean;
  controllerPassed: boolean;
  /** A change to the code or guidance governing FLIGHT needs an independent controller verdict. */
  protectedController?: boolean;
  note: string | null;
}
const key = (repo: string, pr: number, sha: string) => `external-pr-control:${repo}#${pr}@${sha}`;
const holdKey = (repo: string, pr: number) => `external-pr-merge-hold:${repo}#${pr}`;

export function externalPrControl(
  store: Store,
  repo: string,
  pr: number,
  sha: string,
): ExternalPrControl | null {
  const value = store.getSetting(key(repo, pr, sha));
  if (value === null) return null;
  try {
    const row = JSON.parse(value) as ExternalPrControl;
    if (
      typeof row.since !== "number" ||
      ![row.uatRequired, row.uatAccepted, row.controllerRequired, row.controllerPassed].every(
        (v) => typeof v === "boolean",
      )
    )
      return null;
    return row;
  } catch {
    return null;
  }
}

export function setExternalPrControl(
  store: Store,
  repo: string,
  pr: number,
  sha: string,
  value: ExternalPrControl,
): void {
  store.setSetting(key(repo, pr, sha), JSON.stringify(value));
}

export function externalMergeHold(store: Store, repo: string, pr: number): string | null {
  return store.getSetting(holdKey(repo, pr));
}
export function setExternalMergeHold(
  store: Store,
  repo: string,
  pr: number,
  reason: string | null,
): void {
  if (reason === null) store.deleteSetting(holdKey(repo, pr));
  else store.setSetting(holdKey(repo, pr), reason);
}

export function externalControlReason(
  store: Store,
  repo: string,
  pr: number,
  sha: string,
): string | null {
  const hold = externalMergeHold(store, repo, pr);
  if (hold !== null) return hold;
  const control = externalPrControl(store, repo, pr, sha);
  if (control?.controllerRequired && !control.controllerPassed)
    return control.note ?? "Waiting for the controller's evidence on this PR head.";
  if (control?.uatRequired && !control.uatAccepted)
    return control.note ?? "Waiting for the operator's acceptance of this PR head.";
  return null;
}
