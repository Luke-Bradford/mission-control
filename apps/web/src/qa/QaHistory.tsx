import type { QaHistoryEntry, QaHistoryPage, QaNativeHistory, ReviewShotView } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { apiReviewImage } from "../api.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { hub, streamStatus, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { followLink, navigate, useSearch } from "../router.ts";
import { useStore } from "../shell/store.ts";
import "./qa-history.css";

const TOPICS = ["agents", "boards", "config"] as const;
const retry = () => {
  hub.refetchTopic("agents");
  hub.refetchTopic("boards");
};
const date = (at: number | null) =>
  at === null
    ? "Time not recorded"
    : new Date(at).toISOString().replace("T", " ").replace(".000Z", " UTC");
const verdict = (entry: QaHistoryEntry) =>
  entry.verdict
    ? `Spec ${entry.verdict.spec} · quality ${entry.verdict.quality}`
    : `No verdict · ${entry.state}`;
const path = (repo: string, cursor?: string) =>
  `/qa?view=history${repo ? `&repo=${encodeURIComponent(repo)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

export function QaNavigation({ history }: { history: boolean }) {
  return (
    <nav className="qa-navigation" aria-label="QA views">
      <a
        href="/qa"
        onClick={(e) => followLink(e, "/qa")}
        aria-current={!history ? "page" : undefined}
      >
        Current
      </a>
      <a
        href="/qa?view=history"
        onClick={(e) => followLink(e, "/qa?view=history")}
        aria-current={history ? "page" : undefined}
      >
        History
      </a>
    </nav>
  );
}

/** Fetches one lightweight page. Neither report bodies nor protected images load in the index. */
export function QaHistory() {
  const params = new URLSearchParams(useSearch());
  const repo = params.get("repo") ?? "";
  const cursor = params.get("cursor");
  const resource = useResource<QaHistoryPage>({
    path: `/api/qa/history?limit=50${repo ? `&repoId=${encodeURIComponent(repo)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    topic: TOPICS,
  });
  const connected = useStore(streamStatus).connected;
  const heading = useRef<HTMLHeadingElement>(null);
  const previousScope = useRef(`${repo}:${cursor}`);
  useEffect(() => {
    const scope = `${repo}:${cursor}`;
    if (previousScope.current !== scope) heading.current?.focus();
    previousScope.current = scope;
  }, [repo, cursor]);
  const page = resource.data;
  return (
    <section id="page-qa-readiness" className="uat-page qa-history">
      <header className="uat-title">
        <h1 ref={heading} tabIndex={-1}>
          QA · Review history
        </h1>
        <p>
          Saved reports and retained native reviews. Historical verdicts never approve a newer head.
        </p>
      </header>
      {!connected && (
        <p className="uat-banner" role="status">
          Disconnected from the hub. Showing only history already loaded; reconnect to fetch other
          pages.
        </p>
      )}
      <div className="qa-history-toolbar">
        <label>
          Repository{" "}
          <select value={repo} onChange={(e) => navigate(path(e.target.value))}>
            <option value="">All configured repositories</option>
            {page?.repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
            {repo && !page?.repositories.some((r) => r.id === repo) && (
              <option value={repo}>{repo}</option>
            )}
          </select>
        </label>
        <button type="button" onClick={retry}>
          Refresh history
        </button>
      </div>
      {resource.error && (
        <p className="uat-banner crit-t" role="alert">
          {page ? "Showing the last loaded history page. " : "Review history could not be loaded. "}
          {resource.error.message}{" "}
          <button type="button" onClick={retry}>
            Retry history
          </button>
        </p>
      )}
      {resource.loading && !page && <p role="status">Loading review history…</p>}
      {page && (
        <>
          <Panel title="Past reviews" sub="Newest recorded first · up to 50 per page">
            {!page.entries.length ? (
              <p className="pb">
                No retained reviews match this repository and page. Older records may have been
                pruned.
              </p>
            ) : (
              <section
                className="qa-history-scroll"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll a bounded table.
                tabIndex={0}
                aria-label="Past reviews table, scroll for more rows and columns"
              >
                <table className="qa-history-table">
                  <caption className="sr-only">
                    Historical QA records, newest registration or native completion first. Open a
                    record for its full identity and evidence.
                  </caption>
                  <colgroup>
                    <col className="qa-history-identity" />
                    <col className="qa-history-reviewer" />
                    <col className="qa-history-result" />
                    <col className="qa-history-evidence" />
                    <col className="qa-history-open" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">PR and commit</th>
                      <th scope="col">Reviewer and review time</th>
                      <th scope="col">Recorded verdict</th>
                      <th scope="col">CI and evidence</th>
                      <th scope="col">Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.entries.map((entry) => (
                      <HistoryRow key={entry.key} entry={entry} />
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            <nav className="qa-history-pagination pb" aria-label="Review history pages">
              {cursor && (
                <a href={path(repo)} onClick={(e) => followLink(e, path(repo))}>
                  First page
                </a>
              )}
              <span>{page.entries.length} records on this page</span>
              {page.nextCursor && (
                <a
                  href={path(repo, page.nextCursor)}
                  onClick={(e) => followLink(e, path(repo, page.nextCursor ?? undefined))}
                >
                  Older reviews
                </a>
              )}
            </nav>
          </Panel>
          <div className="qa-history-limits">
            {page.limitations.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function HistoryRow({ entry }: { entry: QaHistoryEntry }) {
  return (
    <tr>
      <th scope="row">
        <span className="qa-history-preview">
          {entry.repoId} · PR #{entry.prNumber} · {entry.title}
        </span>
        <code>{entry.headSha.slice(0, 12)}</code>
        <details>
          <summary>Full identity</summary>
          <p>
            {entry.repoId} · PR #{entry.prNumber}
          </p>
          <p>{entry.title}</p>
          <code>{entry.headSha}</code>
          <p>Recorded {date(entry.recordedAt)}</p>
          <p>
            Reviewer: {entry.reviewer.label} ({entry.reviewer.id})
            {entry.reviewer.model && ` · ${entry.reviewer.model}`}
          </p>
        </details>
      </th>
      <td>
        <span className="qa-history-preview">{entry.reviewer.label}</span>
        <time>{date(entry.reviewedAt)}</time>
      </td>
      <td>
        {verdict(entry)}
        <span className="qa-history-note">
          {entry.kind === "report"
            ? `${entry.source === "controller" ? "Controller" : "Native"} saved report`
            : `Native record · ${entry.state}`}
        </span>
      </td>
      <td>
        <span>Recorded CI {entry.ci === "unavailable" ? "not retained" : entry.ci}</span>
        <span className="qa-history-note">
          Evidence {entry.evidence === "legacy" ? "predates saved report" : entry.evidence}
        </span>
        <span className="qa-history-note">
          Images:{" "}
          {entry.visual === "not_applicable"
            ? "not applicable · reason in report"
            : entry.kind === "native"
              ? `${entry.screenshotCount} recorded · availability unknown`
              : `${entry.pairCount} pairs · ${entry.screenshotCount} other · ${entry.visual}`}
        </span>
      </td>
      <td>
        <a
          href={entry.permalink}
          onClick={(e) => followLink(e, entry.permalink)}
          aria-label={`Open ${entry.kind === "report" ? "saved report" : "native review"} for ${entry.repoId} PR ${entry.prNumber} at ${entry.headSha}`}
        >
          Open {entry.kind === "report" ? "report" : "review"}
        </a>
      </td>
    </tr>
  );
}

export function NativeQaHistory({ id, identity }: { id: string; identity: string | null }) {
  const valid =
    /^[1-9]\d*$/.test(id) &&
    Number.isSafeInteger(Number(id)) &&
    identity !== null &&
    /^[a-f0-9]{64}$/.test(identity);
  const resource = useResource<QaNativeHistory>(
    valid ? { path: `/api/qa/history/native/${id}?identity=${identity}`, topic: TOPICS } : null,
  );
  const record = resource.data;
  const matches =
    record?.review.id === Number(id) &&
    new URLSearchParams(record.entry.permalink.split("?")[1]).get("identity") === identity;
  const connected = useStore(streamStatus).connected;
  return (
    <section id="page-qa-readiness" className="uat-page qa-history">
      <header className="uat-title">
        <h1>QA · Original native review</h1>
        <a href="/qa?view=history" onClick={(e) => followLink(e, "/qa?view=history")}>
          Return to review history
        </a>
      </header>
      {!connected && (
        <p className="uat-banner" role="status">
          Disconnected from the hub. This retained record may be unavailable.
        </p>
      )}
      {!valid || (record && !matches) ? (
        <p role="alert">The native review reference is invalid.</p>
      ) : resource.error ? (
        <p role="alert">
          The stored review could not be loaded. It may have been pruned.{" "}
          <button type="button" onClick={retry}>
            Retry review
          </button>
        </p>
      ) : !record ? (
        <p role="status">Loading the stored native review…</p>
      ) : (
        <>
          <Panel title={`${record.entry.repoId} · PR #${record.entry.prNumber}`}>
            <div className="pb qa-history-native">
              <h2>
                {record.entry.title} · {record.review.state}
              </h2>
              <p>
                Review seat: {record.entry.reviewer.label} ({record.entry.reviewer.id})
                {record.entry.reviewer.model && ` · ${record.entry.reviewer.model}`}
              </p>
              <p>
                Reviewed: {date(record.entry.reviewedAt)} · {verdict(record.entry)}
              </p>
              <code>{record.entry.headSha}</code>
              <div className="qa-history-toolbar">
                <ExternalLink url={record.prUrl} label="Open original PR on GitHub">
                  GitHub PR
                </ExternalLink>
                {record.headUrl && (
                  <ExternalLink url={record.headUrl} label="Open exact commit on GitHub">
                    Exact commit
                  </ExternalLink>
                )}
              </div>
              <p>{record.review.summary ?? "No review summary was recorded."}</p>
              {record.review.failure && <p>Review did not complete: {record.review.failure}</p>}
              <p>
                Historical CI: not retained. Image applicability: unknown; no immutable before/after
                snapshot.
              </p>
            </div>
          </Panel>
          <div className="qa-history-limits">
            {record.limitations.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
          <Panel title="Stored coverage and findings">
            <div className="pb qa-history-native">
              {record.coverage.length ? (
                record.coverage.map((c) => (
                  <p key={c.check}>
                    {c.check}: {c.result}
                    {c.note && ` · ${c.note}`}
                  </p>
                ))
              ) : (
                <p>No checklist coverage was retained.</p>
              )}
              {record.findings.map((f) => (
                <details key={f.pos}>
                  <summary>
                    {f.severity} · {f.summary}
                  </summary>
                  <p>
                    {f.file}:{f.line} · {f.state}
                    {f.resolution && ` · ${f.resolution}`}
                  </p>
                  <p>{f.scenario}</p>
                  <p>Suggested fix: {f.fix}</p>
                </details>
              ))}
              {!record.findings.length && <p>No findings were retained for this review.</p>}
            </div>
          </Panel>
          <Panel title="Reviewer-reported tests">
            <div className="pb qa-history-native">
              <p>
                These are reported counts. This legacy record does not prove execution or preserve
                command receipts.
              </p>
              {record.tests.map((test, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: legacy tests are immutable insertion-ordered rows within this keyed review record.
                <details key={`${n}:${test.command}`}>
                  <summary>{test.command}</summary>
                  <p>{test.file ?? "File not recorded"}</p>
                  <p>
                    Reported: {test.passed} passed · {test.failed} failed · {test.skipped} skipped ·{" "}
                    {test.duration} ms
                  </p>
                </details>
              ))}
              {!record.tests.length && <p>No test counts were retained.</p>}
            </div>
          </Panel>
          <Panel title="Recorded browser screenshots">
            <div className="pb qa-history-native">
              <p>Loaded only when requested. Pruned images remain unavailable.</p>
              {record.screenshots.map((shot) => (
                <LegacyShot key={shot.id} shot={shot} />
              ))}
              {!record.screenshots.length && <p>No browser screenshot references were retained.</p>}
            </div>
          </Panel>
        </>
      )}
    </section>
  );
}

function LegacyShot({ shot }: { shot: ReviewShotView }) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load() {
    setBusy(true);
    setError(false);
    try {
      const blob = await apiReviewImage(shot.id);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("image"));
        reader.readAsDataURL(blob);
      });
      if (mounted.current) setImage(data);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <figure>
      <figcaption>
        {shot.label} · {shot.width}px · {shot.theme} · {date(shot.at)}
      </figcaption>
      {!image && (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading screenshot…" : error ? "Retry screenshot" : "Load recorded screenshot"}
        </button>
      )}
      {error && (
        <p role="alert">
          The screenshot is unavailable or access was refused. Its original bytes may have expired.
        </p>
      )}
      {image && (
        <img
          src={image}
          alt={shot.label}
          onError={() => {
            setImage(undefined);
            setError(true);
          }}
        />
      )}
    </figure>
  );
}
