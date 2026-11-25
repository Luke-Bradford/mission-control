import type { SessionPr } from "@mc/core";
import type { GhRunner } from "../mcp/gh.ts";
import type { Store } from "../store.ts";

export const PR_RECHECK_MS = 120_000;
export const NO_PR_RECHECK_MS = 600_000;
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^\w[\w./-]*$/;

const ciOf = (rollup: unknown): SessionPr["ci"] => {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const states = rollup.map((item) =>
    String(
      (item as { conclusion?: unknown }).conclusion ?? (item as { status?: unknown }).status ?? "",
    ).toUpperCase(),
  );
  if (states.some((state) => /FAIL|ERROR|CANCEL/.test(state))) return "failing";
  if (states.some((state) => /PENDING|QUEUED|IN_PROGRESS|WAITING/.test(state))) return "pending";
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
    { at: number; value: Promise<{ pr: SessionPr | null; repoId: string | null }> }
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
      if (prior && now - prior.at < NO_PR_RECHECK_MS) return prior.value;
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
      cache.set(key, { at: now, value });
      return value;
    },
  };
}
