import { REPO_TOKEN_NAMES } from "./theme.ts";

/**
 * A repo's chip colour: the palette in config order, wrapping after the last colour, so a repo
 * keeps its colour across reloads and pages. `repoIds` is the config's repos in file order; null
 * for a repo that is not in it.
 */
export function repoColor(repoIds: readonly string[], repoId: string): string | null {
  const at = repoIds.indexOf(repoId);
  return at < 0 ? null : `var(${REPO_TOKEN_NAMES[at % REPO_TOKEN_NAMES.length]})`;
}
