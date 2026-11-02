import type { ConfigView, QaReport } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { githubRepoOfUrl } from "../links.ts";
import "./ticket-qa.css";

const TOPICS = ["agents", "boards"] as const;

export interface TicketQaPr {
  number: number;
  url: string;
  headSha?: string | null;
}

function Reports({ repoId, github, pr }: { repoId: string; github: string; pr: TicketQaPr }) {
  const path = `/api/qa-reports?repoId=${encodeURIComponent(repoId)}&prNumber=${pr.number}`;
  const res = useResource<{ reports: QaReport[] }>({ path, topic: TOPICS });
  const reports =
    res.data?.reports.filter(
      (report) =>
        report.repoId === repoId &&
        report.prNumber === pr.number &&
        report.github.toLowerCase() === github.toLowerCase(),
    ) ?? [];
  return (
    <li>
      <span className="mono">{`${repoId} PR #${pr.number}`}</span>
      {res.error ? (
        <p className="warn-t">Saved QA reports could not be loaded. Reload the ticket to retry.</p>
      ) : res.data === undefined ? (
        <p className="muted">Loading saved QA reports…</p>
      ) : reports.length === 0 ? (
        <p className="muted">
          No saved QA report. Review coverage and screenshots are not recorded here.
        </p>
      ) : (
        <ul>
          {reports.map((report) => (
            <li key={report.id}>
              <a href={report.permalink} className="ticket-qa-link">
                {`Open QA report · ${report.headSha.slice(0, 8)}`}
              </a>
              <p>
                {report.reviewer.label} ·{" "}
                {report.completeness.state === "complete"
                  ? "Evidence complete"
                  : "Evidence incomplete"}
                {pr.headSha && report.headSha !== pr.headSha ? " · Earlier PR commit" : ""}
              </p>
              <p className="muted">
                {`Spec: ${report.verdict.spec} · Quality: ${report.verdict.quality} · `}
                {report.visual.applicability === "not_applicable"
                  ? "Screenshots not applicable"
                  : `${report.visual.pairs.length} before/after ${report.visual.pairs.length === 1 ? "pair" : "pairs"}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Resolve the PR's GitHub identity, including cross-repo closing PRs; never guess from its ticket. */
export function TicketQaReports({ prs }: { prs: TicketQaPr[] }) {
  const config = useResource<ConfigView>(RESOURCES.config);
  if (prs.length === 0)
    return (
      <p className="muted">
        No associated pull request is recorded. QA coverage has not been established.
      </p>
    );
  if (config.error)
    return (
      <p className="warn-t">
        QA reports could not be matched to configured repositories. Reload the ticket to retry.
      </p>
    );
  if (!config.data) return <p className="muted">Loading QA report references…</p>;
  const repos = config.data.repos;
  return (
    <ul className="ticket-qa" aria-label="Saved QA reports">
      {prs.map((pr) => {
        const github = githubRepoOfUrl(pr.url);
        const repo =
          /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/i.test(pr.url) &&
          pr.url.endsWith(`/pull/${pr.number}`)
            ? repos.find((r) => r.github.toLowerCase() === github?.toLowerCase())
            : undefined;
        return repo ? (
          <Reports key={pr.url} repoId={repo.id} github={repo.github} pr={pr} />
        ) : (
          <li key={pr.url}>
            PR #{pr.number}: QA reports unavailable; its repository is not configured.
          </li>
        );
      })}
    </ul>
  );
}
