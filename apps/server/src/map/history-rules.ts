/** Shared Map/code-health coupling definitions. Broad PRs still count as file touches. */
export const MAP_COUPLING_MIN = 4;
export const MAP_COUPLING_CAP = 600;
export const MAP_COUPLING_PR_FILES_MAX = 25;
export function mapCouplingEligible(sharedPrs: number, lessFrequentlyChangedFilePrs: number) {
  return sharedPrs >= MAP_COUPLING_MIN && sharedPrs * 2 >= lessFrequentlyChangedFilePrs;
}
