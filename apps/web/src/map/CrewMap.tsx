import { type Resource, useResource } from "../data.ts";

/**
 * Kept as the named reader of the PR-files route until the server half of the Map removal drops
 * the route. Nothing renders or imports this.
 */
export function usePrFiles(repo: string | null, pr: number | null): Resource<{ files: string[] }> {
  return useResource<{ files: string[] }>(
    repo && pr !== null
      ? { path: `/api/repos/${encodeURIComponent(repo)}/prs/${pr}/files`, topic: "boards" }
      : null,
  );
}
