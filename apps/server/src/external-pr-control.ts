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

const askKey = (repo: string, pr: number) => `external-review-ask:${repo}#${pr}`;

/** Who an ask seeded by Update is recorded as. */
const SEEDED_BY = "Update";

interface Ask {
  at: number;
  by: string;
  sha: string;
}

function readAsk(store: Store, repo: string, pr: number): Ask | null {
  const value = store.getSetting(askKey(repo, pr));
  if (value === null) return null;
  try {
    const ask = JSON.parse(value) as Ask;
    return typeof ask.sha === "string" ? ask : null;
  } catch {
    return null;
  }
}

/**
 * Whether the operator or FLIGHT asked this hub for a QA review of this head of the PR. The ask is
 * in this store only and binds one head: a push needs a new ask. An ask Update seeded for a review
 * in flight counts only for that review (`forReview`), never for card moves or PR body edits.
 */
export function externalReviewAsked(
  store: Store,
  repo: string,
  pr: number,
  sha: string,
  forReview = false,
): boolean {
  const ask = readAsk(store, repo, pr);
  return ask?.sha === sha && (forReview || ask.by !== SEEDED_BY);
}

/** Records the ask for `sha`; asking again for the same head changes nothing, a new head or a real ask over a seeded one replaces it. */
export function askExternalReview(
  store: Store,
  repo: string,
  pr: number,
  by: "FLIGHT" | "CAPCOM" | typeof SEEDED_BY,
  at: number,
  sha: string,
): void {
  // skip only when the ask adds nothing: an operator or FLIGHT ask replaces Update's seeded one,
  // and Update never downgrades a real ask
  if (externalReviewAsked(store, repo, pr, sha, by === SEEDED_BY)) return;
  store.setSetting(askKey(repo, pr), JSON.stringify({ at, by, sha }));
}

/** Takes the ask back; true when there was one. */
export function withdrawExternalReview(store: Store, repo: string, pr: number): boolean {
  if (store.getSetting(askKey(repo, pr)) === null) return false;
  store.deleteSetting(askKey(repo, pr));
  return true;
}

/**
 * Update seeds the asks of reviews still in flight (queued, starting or running), so a hub that updates keeps finishing them
 * (a pending mc/review status is never left behind). Runs once; later asks are the operator's.
 */
export function seedExternalReviewAsks(store: Store, at: number): void {
  const seeded = "external-review-asks-seeded";
  if (store.getSetting(seeded) !== null) return;
  for (const row of store.externalReviewRows()) {
    // only a review still in flight: a finished one gives this hub no claim on the PR
    if (row.state !== "queued" && row.state !== "starting" && row.state !== "running") continue;
    askExternalReview(store, row.repoId, row.prNumber, SEEDED_BY, at, row.sha);
  }
  store.setSetting(seeded, String(at));
}
