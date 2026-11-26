import type { SessionPr } from "@mc/core";
import type { GhRunner } from "../mcp/gh.ts";
import type { Store } from "../store.ts";

export const PR_RECHECK_MS = 120_000;
export const NO_PR_RECHECK_MS = 600_000;
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^\w[\w./-]*$/;

const ciOf = (rollup: unknown): SessionPr["ci"] => {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const states = rollup.map((item) => {
    const row = item as { conclusion?: unknown; status?: unknown; state?: unknown };
    return String(row.conclusion || row.status || row.state || "").toUpperCase();
  });
  if (states.some((state) => /FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/.test(state)))
    return "failing";
  if (states.some((state) => /PENDING|EXPECTED|QUEUED|IN_PROGRESS|WAITING|REQUESTED/.test(state)))
    return "pending";
  return "passing";
};

export function createBranchPrs(deps: {
  store: Pick<Store, "openPullRequests">;
  repos: () => { id: string; github: string }[];
  gh: GhRunner;
  now?: () => number;
}) {
  const cache = new Map<
    string,
    { at: number; ttl: number; value: Promise<{ pr: SessionPr | null; repoId: string | null }> }
  >();
  return {
    async prOf(
      github: string,
      branch: string,
    ): Promise<{ pr: SessionPr | null; repoId: string | null }> {
      if (!SLUG.test(github) || !BRANCH.test(branch)) return { pr: null, repoId: null };
      const configured = deps
        .repos()
        .find((repo) => repo.github.toLowerCase() === github.toLowerCase());
      if (configured) {
        const found =
          deps.store.openPullRequests(configured.id).find((pr) => pr.branch === branch) ?? null;
        return {
          repoId: configured.id,
          pr: found && {
            number: found.number,
            url: found.url,
            isDraft: found.isDraft,
            ci: found.ci,
            review: found.review,
          },
        };
      }
      const key = `${github}:${branch}`;
      const now = deps.now?.() ?? Date.now();
      const prior = cache.get(key);
      if (prior && now - prior.at < prior.ttl) return prior.value;
      const value = deps
        .gh(
          [
            "pr",
            "list",
            `--repo=${github}`,
            `--head=${branch}`,
            "--state=open",
            "--limit=1",
            "--json=number,url,isDraft,reviewDecision,statusCheckRollup",
          ],
          { cwd: process.cwd() },
        )
        .then((result) => {
          if (result.code !== 0) return { pr: null, repoId: null };
          const row = (JSON.parse(result.stdout) as unknown[]).at(0) as
            | Record<string, unknown>
            | undefined;
          if (!row || typeof row.number !== "number" || typeof row.url !== "string")
            return { pr: null, repoId: null };
          const review: SessionPr["review"] =
            row.reviewDecision === "APPROVED"
              ? "approved"
              : row.reviewDecision === "CHANGES_REQUESTED"
                ? "changes"
                : row.reviewDecision === "REVIEW_REQUIRED"
                  ? "requested"
                  : null;
          return {
            repoId: null,
            pr: {
              number: row.number,
              url: row.url,
              isDraft: row.isDraft === true,
              review,
              ci: ciOf(row.statusCheckRollup),
            },
          };
        })
        .catch(() => ({ pr: null, repoId: null }));
      const entry = { at: now, ttl: NO_PR_RECHECK_MS, value };
      cache.set(key, entry);
      void value.then(({ pr }) => {
        entry.ttl = pr?.ci === "pending" ? PR_RECHECK_MS : NO_PR_RECHECK_MS;
      });
      return value;
    },
  };
}
