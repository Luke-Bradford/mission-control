import type {
  CiRunsView,
  PullRequestView,
  QaFindingsView,
  QaFindingView,
  RepoView,
} from "@mc/core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { prLabel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { githubHref } from "../links.ts";
import { checkedHead, markChecked, onCheckedChange, undoChecked } from "../qa/checked.ts";
import { isOpenFinding, prVerdict } from "../qa/readiness.ts";
import "./qa-readiness.css";

const NO_REPOS: RepoView[] = [];
const NO_PRS: PullRequestView[] = [];
const NO_FINDINGS: QaFindingView[] = [];
const NO_RUNS: CiRunsView["runs"] = [];
const QA_EVIDENCE_FOLLOW_UP = "#1082";

type CheckState = "passing" | "failing" | "pending";
const STATE_TONE: Record<CheckState, "ok" | "crit" | "warn"> = {
  passing: "ok",
  failing: "crit",
  pending: "warn",
};

/** QA's per-head operator review: it does not claim uncaptured evidence exists. */
export function QaReadiness() {
  const reposRes = useResource<RepoView[]>(RESOURCES.repos);
  const repos = reposRes.data ?? NO_REPOS;
  const prResources = useResources<PullRequestView[]>(
    repos.map((repo) => ({
      path: `/api/repos/${encodeURIComponent(repo.id)}/prs`,
      topic: "boards",
    })),
  );
  const ci = useResource<CiRunsView>({ path: "/api/qa/ci-runs?days=90", topic: "boards" });
  const findings = useResource<QaFindingsView>({
    path: "/api/qa/findings?days=90",
    topic: "agents",
  });
  const [revision, setRevision] = useState(0);
  // The command palette marks heads too; re-read when it does.
  useEffect(() => onCheckedChange(() => setRevision((value) => value + 1)), []);
  const prs = useMemo(
    () =>
      prResources
        .flatMap((resource) => resource.data ?? NO_PRS)
        .filter((pr) => pr.state === "open"),
    [prResources],
  );
  const prLoading = prResources.some((resource) => resource.loading);
  const prError = prResources.find((resource) => resource.error)?.error;
  const loading = reposRes.loading || prLoading;
  const loadError = reposRes.error ?? prError;
  return (
    <section id="page-qa-readiness">
      <div className="toolbar">
        <h1 className="toolbar-heading">PR readiness</h1>
        <span className="note">
          One card per open pull request. A check is local to this browser.
        </span>
      </div>
      {loading && <p className="s">Loading open pull requests…</p>}
      {loadError && (
        <p className="s crit-t">Could not load open pull requests: {loadError.message}</p>
      )}
      {(ci.error || findings.error) && (
        <p className="s warn-t">
          Some readiness evidence is unavailable. Cards show the latest PR state.
        </p>
      )}
      {!loading && !loadError && prs.length === 0 && (
        <p className="s fg2">No open pull requests to check.</p>
      )}
      <div className="qa-readiness-list">
        {prs.map((pr) => (
          <ReadinessCard
            key={`${pr.repoId}:${pr.number}`}
            pr={pr}
            runs={ci.data?.runs ?? NO_RUNS}
            findings={findings.data?.findings ?? NO_FINDINGS}
            findingsKnown={findings.data !== undefined && findings.error === null}
            revision={revision}
            onChanged={() => setRevision((value) => value + 1)}
          />
        ))}
      </div>
    </section>
  );
}

function ReadinessCard({
  pr,
  runs,
  findings,
  findingsKnown,
  revision: _revision,
  onChanged,
}: {
  pr: PullRequestView;
  runs: readonly CiRunsView["runs"][number][];
  findings: readonly QaFindingView[];
  findingsKnown: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const prRuns = runs.filter((run) => run.repoId === pr.repoId && run.prNumber === pr.number);
  const prFindings = findings.filter(
    (finding) => finding.repoId === pr.repoId && finding.prNumber === pr.number,
  );
  const openFindings = prFindings.filter(isOpenFinding);
  const verdict = prVerdict(pr, openFindings, findingsKnown);
  const currentRuns = pr.headSha === null ? [] : prRuns.filter((run) => run.sha === pr.headSha);
  const olderRuns = pr.headSha === null ? prRuns : prRuns.filter((run) => run.sha !== pr.headSha);
  const storedHead = checkedHead(pr.repoId, pr.number);
  const checked = pr.headSha !== null && storedHead === pr.headSha;
  const changed = storedHead !== null && storedHead !== pr.headSha;
  const size =
    pr.additions == null || pr.deletions == null
      ? "Size not captured"
      : `${pr.additions + pr.deletions} lines · ${pr.changedFiles ?? "—"} files`;
  const diffUrl = githubHref(pr.url) ? githubHref(`${pr.url}/files`) : null;
  return (
    <Panel
      title={
        <span className="qa-title">
          <ExternalLink url={pr.url} label={`${pr.repoId} ${prLabel(pr.number)} on GitHub`}>
            {`${pr.repoId} · ${prLabel(pr.number)}`}
          </ExternalLink>
          <span title={pr.title}>{pr.title}</span>
        </span>
      }
      className="qa-readiness-card"
      actions={<Pill tone={verdict.tone}>{verdict.text}</Pill>}
    >
      <div className="pb qa-card-body">
        <div className="qa-evidence">
          <Evidence title="Checks and CI tries">
            {currentRuns.length > 0 ? (
              currentRuns.map((run) => (
                <span key={`${run.sha}:${run.name}:${run.attempt}`}>
                  <Pill
                    tone={STATE_TONE[run.state]}
                  >{`${run.name} · try ${run.attempt || 1} · ${run.state}`}</Pill>
                </span>
              ))
            ) : pr.checks?.length ? (
              pr.checks.map((check) => (
                <span key={`${check.id ?? check.name}:${check.attempt ?? 0}`}>
                  <Pill
                    tone={STATE_TONE[check.state]}
                  >{`${check.name} · try ${check.attempt ?? "—"} · ${check.state}`}</Pill>
                </span>
              ))
            ) : (
              <Empty text="No CI tries captured for this head." />
            )}
            {olderRuns.length > 0 && (
              <span>{`Older heads: ${olderRuns.map((run) => `${run.name} · ${run.sha.slice(0, 7)} · ${run.state}`).join("; ")}`}</span>
            )}
          </Evidence>
          <Evidence title="Review findings">
            {findingsKnown ? (
              <span>{`${prFindings.length} total · ${openFindings.length} open · ${prFindings.length - openFindings.length} resolved`}</span>
            ) : (
              <Empty text="Review findings are still loading." />
            )}
            {openFindings.length > 0 && (
              <span>{`Open by severity: ${severitySummary(openFindings)}`}</span>
            )}
            {prFindings.length > openFindings.length && (
              <span>{`Resolved by severity: ${severitySummary(
                prFindings.filter((finding) => !isOpenFinding(finding)),
              )}`}</span>
            )}
            {findingsKnown && prFindings.length === 0 && (
              <Empty text="No review findings captured." />
            )}
            <Empty
              text={`Open findings cover the last 90 days; older unresolved findings are not captured yet (${QA_EVIDENCE_FOLLOW_UP}).`}
            />
          </Evidence>
          <Evidence title="Review rounds">
            <Empty text={`Clean review rounds are not captured yet (${QA_EVIDENCE_FOLLOW_UP}).`} />
          </Evidence>
          <Evidence title="Change">
            <span>{size}</span>
            <span>Hard-rule paths not captured.</span>
            {diffUrl ? (
              <ExternalLink
                url={diffUrl}
                label={`${pr.repoId} ${prLabel(pr.number)} files on GitHub`}
              >
                View diff
              </ExternalLink>
            ) : (
              <Empty text="Diff link unavailable." />
            )}
          </Evidence>
          <Evidence title="Before and after">
            <Empty text="Before/after evidence is not captured yet." />
          </Evidence>
          <Evidence title="Tests">
            <Empty text="Added or changed tests are not captured yet." />
          </Evidence>
        </div>
        <div className="qa-check-action">
          {checked ? (
            <>
              <span className="ok-t">Checked at this head.</span>
              <button
                type="button"
                onClick={() => {
                  undoChecked(pr.repoId, pr.number);
                  onChanged();
                }}
              >
                Undo checked
              </button>
            </>
          ) : pr.headSha === null ? (
            <span className="fg2">
              Head SHA is not available, so this PR cannot be marked checked.
            </span>
          ) : (
            <>
              {changed && (
                <span className="warn-t">Changed since your check: new head pushed.</span>
              )}
              <button
                type="button"
                onClick={() => {
                  markChecked(pr.repoId, pr.number, pr.headSha as string);
                  onChanged();
                }}
              >
                Mark checked
              </button>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Evidence({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="qa-evidence-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <span className="fg2">{text}</span>;
}

const severitySummary = (findings: readonly QaFindingView[]): string =>
  Object.entries(
    findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
      return counts;
    }, {}),
  )
    .map(([severity, count]) => `${severity} ${count}`)
    .join(" · ");
