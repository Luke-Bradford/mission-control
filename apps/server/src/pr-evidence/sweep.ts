/** Capture open HUD PRs even when a controller, rather than a crew run, opened them. */
import {
  EVIDENCE_HEADING,
  type EvidenceManifest,
  evidenceSectionText,
  type PullRequestView,
  prEvidenceAffectedPages,
  type RepoId,
  withSection,
} from "@mc/core";
import type { GhRunner } from "../mcp/gh.ts";
import type { Store } from "../store.ts";
import type { PrEvidence } from "./capture.ts";

export async function trustedEvidenceHead(
  gh: GhRunner,
  cwd: string,
  repo: string,
  pr: PullRequestView,
): Promise<boolean> {
  const result = await gh(["api", `repos/${repo}/pulls/${pr.number}`], { cwd });
  if (result.code !== 0) return false;
  const current = JSON.parse(result.stdout) as {
    state?: string;
    head?: { sha?: string; repo?: { full_name?: string } };
  };
  return (
    current.state === "open" &&
    current.head?.sha === pr.headSha &&
    current.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()
  );
}

export async function postPrEvidence(
  gh: GhRunner,
  cwd: string,
  repo: string,
  manifest: EvidenceManifest,
  baseUrl: string,
): Promise<void> {
  const endpoint = `repos/${repo}/pulls/${manifest.pr}`;
  const viewed = await gh(["api", endpoint], { cwd });
  if (viewed.code !== 0) throw new Error("the PR could not be read for screenshot evidence");
  const pr = JSON.parse(viewed.stdout) as {
    state?: string;
    head?: { sha?: string };
    body?: string | null;
  };
  if (pr.state !== "open" || pr.head?.sha !== manifest.sha)
    throw new Error("the PR closed or its head changed before evidence was posted");
  const body = withSection(pr.body ?? "", EVIDENCE_HEADING, evidenceSectionText(manifest, baseUrl));
  if (body === pr.body) return;
  // Only the existing PR body is edited; no comment, mention, upload, ready or merge write.
  const edited = await gh(["api", "--method", "PATCH", endpoint, "--input", "-"], {
    cwd,
    input: JSON.stringify({ body }),
  });
  if (edited.code !== 0) throw new Error("screenshot evidence links could not be posted to the PR");
}

export function createEvidenceSweep(deps: {
  store: Store;
  evidence: PrEvidence;
  repoId: RepoId;
  post(manifest: EvidenceManifest): Promise<void>;
  /** Fresh provenance check: automatic builds may execute only a same-repository head. */
  trusted(pr: PullRequestView): Promise<boolean>;
  log(text: string): void;
}): { tick(): Promise<void>; stop(): void } {
  let running: Promise<void> | null = null;
  let stopped = false;
  return {
    async tick() {
      if (stopped) return;
      if (running) return running;
      running = (async () => {
        for (const pr of deps.store.pullRequests(deps.repoId)) {
          if (stopped) break;
          if (pr.state !== "open" || !pr.headSha) continue;
          const paths = deps.store.prFilePaths(deps.repoId, pr.number);
          const targetPaths =
            pr.changedFiles != null && paths.length === pr.changedFiles
              ? paths
              : ["apps/web/src/hud.css"];
          if (prEvidenceAffectedPages(targetPaths).length === 0 || !(await deps.trusted(pr)))
            continue;
          await deps.evidence.ensure({
            repoId: deps.repoId,
            pr: pr.number,
            sha: pr.headSha,
            paths: targetPaths,
            onStored: deps.post,
          });
        }
      })()
        .catch((e) =>
          deps.log(`screenshot evidence sweep: ${e instanceof Error ? e.message : String(e)}`),
        )
        .finally(() => {
          running = null;
        });
      return running;
    },
    stop() {
      stopped = true;
    },
  };
}
