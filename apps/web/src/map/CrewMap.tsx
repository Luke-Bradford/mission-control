import { useResource } from "../data.ts";

/**
 * Temporary route reader retained for the server route contract. The Map page no longer imports it.
 * Remove with the map API routes in #1692.
 */
export function usePrFiles(repo: string, pr: string | null) {
  return useResource<{ files: string[] }>(
    pr && /^[1-9]\d*$/.test(pr)
      ? { path: `/api/repos/${encodeURIComponent(repo)}/prs/${pr}/files`, topic: "boards" }
      : null,
  );
}
