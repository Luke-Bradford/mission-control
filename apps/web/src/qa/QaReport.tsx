import { type QaImageRef, type QaReport, REVIEW_CHECK_IDS } from "@mc/core";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { apiQaReportImage } from "../api.ts";
import { hub, useResource } from "../data.ts";
import { shortSha } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import "./qa-report.css";

const TOPICS = ["agents", "boards"] as const;
const timestamp = (at: number | null | undefined) =>
  at == null
    ? "Time not recorded"
    : new Date(at).toISOString().replace("T", " ").replace(".000Z", " UTC");
const retry = () => {
  hub.refetchTopic("agents");
  hub.refetchTopic("boards");
};

/** Reports may link only to retained hub assets or ordinary web evidence, never executable URLs. */
export function qaEvidenceUrl(value: string): string | null {
  if (/^\/api\/qa-report-assets\/[0-9a-f]{64}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function ReportScroll({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the bounded evidence.
    <section className={className} aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}

function EvidenceLink({ url, children }: { url: string; children: ReactNode }) {
  const href = qaEvidenceUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children} · link unavailable</span>
  );
}

/** A permanent report opens independently of the queue, including after its PR has merged. */
export function ArchivedQaReport({
  id,
  repo,
  pr,
}: {
  id: string;
  repo: string | null;
  pr: string | null;
}) {
  const valid = /^[0-9a-f]{64}$/.test(id);
  const resource = useResource<QaReport>(
    valid ? { path: `/api/qa-reports/${id}`, topic: TOPICS } : null,
  );
  const report = resource.data;
  const matches =
    report && (!repo || report.repoId === repo) && (!pr || String(report.prNumber) === pr);
  if (!valid || (report && !matches))
    return (
      <p className="uat-banner" role="alert">
        This report reference does not match the requested PR.
      </p>
    );
  if (resource.error)
    return (
      <p className="uat-banner" role="alert">
        The saved QA report could not be loaded. {resource.error.message}{" "}
        <button type="button" onClick={retry}>
          Retry report
        </button>
      </p>
    );
  if (!report) return <p role="status">Loading the saved QA report…</p>;
  return <QaReportRead report={report} archived />;
}

export function QaReportArchive({
  repo,
  pr,
  head,
}: {
  repo: string;
  pr: number;
  head: string | null;
}) {
  const valid = !head || /^[0-9a-f]{40}$/.test(head);
  const resource = useResource<{ reports: QaReport[] }>(
    valid
      ? {
          path: `/api/qa-reports?repoId=${encodeURIComponent(repo)}&prNumber=${pr}${head ? `&headSha=${head}` : ""}`,
          topic: TOPICS,
        }
      : null,
  );
  const reports =
    resource.data?.reports
      .filter((r) => r.repoId === repo && r.prNumber === pr && (!head || head === r.headSha))
      .sort((a, b) => b.registeredAt - a.registeredAt) ?? [];
  if (!valid)
    return (
      <p className="uat-banner" role="alert">
        The requested commit reference is invalid.
      </p>
    );
  if (resource.error)
    return (
      <p className="uat-banner" role="alert">
        Saved reports could not be loaded. {resource.error.message}{" "}
        <button type="button" onClick={retry}>
          Retry reports
        </button>
      </p>
    );
  return (
    <div className="qa-report">
      <p className="uat-banner">
        Saved QA evidence for {repo} · PR #{pr}
        {head && ` · ${shortSha(head)}`}. This archive does not establish current deployment
        readiness.
      </p>
      {reports.length ? (
        <>
          <nav aria-label="Saved QA report versions">
            <ul>
              {reports.map((r) => (
                <li key={r.id}>
                  <a href={r.permalink}>
                    {timestamp(r.registeredAt)} · {shortSha(r.headSha)} · {r.reviewer.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <QaReportRead report={reports[0]} archived />
        </>
      ) : (
        <p role="status">
          {resource.loading
            ? "Loading saved QA reports…"
            : "No accountable QA report is saved for this PR and commit selection."}
        </p>
      )}
    </div>
  );
}

/** The selected head is mandatory: an older approval never fills a new head's evidence gap. */
export function CurrentQaReport({
  repo,
  pr,
  head,
  children,
}: {
  repo: string;
  pr: number;
  head: string | null;
  children?: ReactNode;
}) {
  const resource = useResource<{ reports: QaReport[] }>(
    head
      ? {
          path: `/api/qa-reports?repoId=${encodeURIComponent(repo)}&prNumber=${pr}&headSha=${head}`,
          topic: TOPICS,
        }
      : null,
  );
  const reports =
    resource.data?.reports
      .filter((r) => r.repoId === repo && r.prNumber === pr && r.headSha === head)
      .sort((a, b) => b.registeredAt - a.registeredAt) ?? [];
  const report = reports[0];
  return (
    <div className="qa-report-current">
      {resource.error ? (
        <p className="uat-banner" role="alert">
          This head’s QA report could not be loaded. {resource.error.message}{" "}
          <button type="button" onClick={retry}>
            Retry report
          </button>
        </p>
      ) : report ? (
        <QaReportRead report={report} currentHead={head} />
      ) : (
        <p className="uat-banner" role="status">
          {resource.loading
            ? "Loading this head’s QA report…"
            : "No accountable QA report is saved for this head. The evidence below does not establish a complete QA sign-off."}
        </p>
      )}
      {(!report || resource.error) && children}
      {reports.length > 1 && (
        <details className="qa-report-history">
          <summary>{reports.length - 1} earlier report versions for this head</summary>
          <ul>
            {reports.slice(1).map((r) => (
              <li key={r.id}>
                <a href={r.permalink}>
                  {timestamp(r.registeredAt)} · {r.reviewer.label}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Image({ image, label }: { image: QaImageRef; label: string }) {
  const target = qaEvidenceUrl(image.url);
  const assetId = target?.match(/^\/api\/qa-report-assets\/([0-9a-f]{64})$/)?.[1];
  const figure = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failedLink, setFailedLink] = useState<string>();
  const [loaded, setLoaded] = useState<{
    id: string;
    url?: string;
    data?: string;
    error?: boolean;
  }>();
  useEffect(() => {
    if (!assetId || !figure.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(figure.current);
    return () => observer.disconnect();
  }, [assetId]);
  const loadKey = assetId ? `${assetId}:${attempt}` : undefined;
  useEffect(() => {
    if (!assetId || !loadKey || !visible) return;
    let active = true;
    let objectUrl: string | undefined;
    let reader: FileReader | undefined;
    void apiQaReportImage(assetId)
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            if (!active) {
              resolve("");
              return;
            }
            // The served HUD permits self/data images. Keep a blob only for opening the full image;
            // the image itself uses the same data-URL transport as existing private review shots.
            objectUrl = URL.createObjectURL(blob);
            reader = new FileReader();
            reader.onload = () =>
              typeof reader?.result === "string"
                ? resolve(reader.result)
                : reject(new Error("Image could not be read."));
            reader.onerror = () => reject(new Error("Image could not be read."));
            reader.onabort = () => reject(new Error("Image read ended."));
            reader.readAsDataURL(blob);
          }),
      )
      .then((data) => {
        if (active) setLoaded({ id: loadKey, url: objectUrl, data });
      })
      .catch(() => {
        if (active) setLoaded({ id: loadKey, error: true });
      });
    return () => {
      active = false;
      if (reader?.readyState === FileReader.LOADING) reader.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, visible, loadKey]);
  const url = assetId
    ? loaded?.id === loadKey
      ? loaded?.url
      : undefined
    : failedLink === target
      ? undefined
      : target;
  const source = assetId ? (loaded?.id === loadKey ? loaded?.data : undefined) : url;
  return (
    <figure ref={figure}>
      <figcaption>
        <strong>{label}</strong>
        <span>
          {shortSha(image.commitSha ?? "")} · {image.source.replaceAll("-", " ")}
        </span>
      </figcaption>
      {url && source ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={source}
            alt={label}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => {
              if (assetId && loadKey) setLoaded({ id: loadKey, error: true });
              else if (target) setFailedLink(target);
            }}
          />
        </a>
      ) : (
        <p>
          {!target ? (
            "Image link unavailable."
          ) : failedLink === target ? (
            <>
              <span>The linked image could not be loaded.</span>{" "}
              <EvidenceLink url={image.sourceUrl ?? target}>Open image source</EvidenceLink>{" "}
              <button
                type="button"
                aria-label={`Retry linked image · ${label}`}
                onClick={() => setFailedLink(undefined)}
              >
                Retry image
              </button>
            </>
          ) : loaded?.id === loadKey && loaded?.error ? (
            <>
              <span>The retained image could not be loaded.</span>{" "}
              <button
                type="button"
                aria-label={`Retry image · ${label}`}
                onClick={() => {
                  setLoaded(undefined);
                  setAttempt((a) => a + 1);
                }}
              >
                Retry image
              </button>
            </>
          ) : (
            "Loading retained image…"
          )}
        </p>
      )}
      <p className="qa-report-note">
        Captured: {timestamp(image.capturedAt)}. {image.provenance}
      </p>
      {image.sourceUrl && <EvidenceLink url={image.sourceUrl}>Git image source</EvidenceLink>}
      {image.sha256 && (
        <details>
          <summary>Image fingerprint</summary>
          <code>{image.sha256}</code>
        </details>
      )}
    </figure>
  );
}

/** Immutable evidence and its gaps; live merge/deployment authority remains outside this report. */
export const QaReportRead = memo(function QaReportRead({
  report: r,
  currentHead,
  archived = false,
}: {
  report: QaReport;
  currentHead?: string | null;
  archived?: boolean;
}) {
  const stale = currentHead !== undefined && currentHead !== r.headSha;
  const failed = r.verdict.spec === "fail" || r.verdict.quality === "fail";
  const ciFailed = r.ci.checks.some((c) => c.state === "failing");
  const ciPending = r.ci.checks.some((c) => c.state === "pending");
  const ciMismatch = r.ci.headSha !== r.headSha;
  const tone =
    failed || ciFailed
      ? "crit"
      : stale || ciPending || ciMismatch || r.completeness.state !== "complete"
        ? "warn"
        : "ok";
  const conclusion = stale
    ? "Different head · not current sign-off"
    : failed
      ? "Rework required"
      : ciMismatch
        ? "CI snapshot is for another commit"
        : ciFailed
          ? "CI failed · review passed"
          : ciPending
            ? "CI pending · review passed"
            : r.completeness.state !== "complete"
              ? "Evidence incomplete"
              : "QA passed · recorded scope";
  const checks = new Map(r.coverage.map((c) => [c.check, c]));
  return (
    <article className="qa-report" aria-label={`QA report for PR #${r.prNumber}`}>
      <Panel title="QA report" sub={`${r.repoId} · PR #${r.prNumber}`}>
        <div className="pb uat-stack">
          <header className="qa-report-heading">
            <h2>{r.prTitle}</h2>
            <Pill tone={tone}>{conclusion}</Pill>
          </header>
          <p>{r.summary}</p>
          <dl className="qa-report-meta">
            <div>
              <dt>Reviewed commit</dt>
              <dd>
                <code>{r.headSha}</code>
              </dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>
                {r.reviewer.label} · {r.reviewer.id}
                {r.reviewer.model && ` · ${r.reviewer.model}`}
              </dd>
            </div>
            <div>
              <dt>Review time</dt>
              <dd>{timestamp(r.reviewedAt)}</dd>
            </div>
            <div>
              <dt>Record saved</dt>
              <dd>
                {timestamp(r.registeredAt)} ·{" "}
                {r.source === "controller" ? "Controller record" : "Native review"}
              </dd>
            </div>
          </dl>
          <p className="qa-report-note">
            {archived ? "Saved historical report. " : "Recorded QA scope. "}New commits require new
            evidence. Deployment still depends on current CI, approvals and holds.
          </p>
          <nav className="qa-report-links" aria-label="QA report references">
            <a href={`#qa-visual-${r.id}`}>Visual confirmation</a>
            <a href={`#qa-tests-${r.id}`}>Tests and receipts</a>
            <a href={`#qa-findings-${r.id}`}>Findings and follow-up</a>
            <a href={r.permalink}>Permanent QA report</a>
            <a href={`/qa?repo=${encodeURIComponent(r.repoId)}&pr=${r.prNumber}&history=1`}>
              All saved report versions
            </a>
            <a href={`/api/qa-reports/${r.id}/markdown`}>Markdown reference</a>
            <a href={`/api/qa-reports/${r.id}`}>JSON record</a>
            <EvidenceLink url={r.prUrl}>GitHub PR</EvidenceLink>
            {r.sourceRef && <EvidenceLink url={r.sourceRef}>Review source</EvidenceLink>}
          </nav>
          {r.completeness.missing.length > 0 && (
            <div className="uat-banner">
              <strong>Missing evidence</strong>
              <ul>
                {r.completeness.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Panel>
      <div className="uat-grid-two">
        <Panel
          id={`qa-checklist-${r.id}`}
          title="QA checklist"
          sub="Recorded scope · missing is not a pass"
        >
          <ReportScroll label="Recorded QA checklist" className="qa-report-scroll">
            <ul className="pb qa-report-checklist">
              {REVIEW_CHECK_IDS.map((id) => {
                const c = checks.get(id);
                return (
                  <li key={id}>
                    <div>
                      <strong>{id.replaceAll("-", " ")}</strong>
                      <Pill
                        tone={c?.result === "pass" ? "ok" : c?.result === "fail" ? "crit" : "plain"}
                      >
                        {c?.result === "n-a" ? "Not applicable" : (c?.result ?? "Not recorded")}
                      </Pill>
                    </div>
                    {c?.note && <p>{c.note}</p>}
                  </li>
                );
              })}
            </ul>
          </ReportScroll>
        </Panel>
        <Panel title="CI gates" sub={`Snapshot · ${r.ci.source} · ${timestamp(r.ci.observedAt)}`}>
          <div className="pb uat-stack">
            <p className="qa-report-note">
              CI head {shortSha(r.ci.headSha)}. {r.ci.limitation}
            </p>
            {r.ci.headSha !== r.headSha && (
              <p className="uat-banner">CI snapshot is for a different commit.</p>
            )}
            <ReportScroll label="Recorded CI gates" className="qa-report-scroll">
              <ul className="qa-report-list">
                {r.ci.checks.map((c) => (
                  <li key={JSON.stringify(c)}>
                    <div>
                      <strong>
                        {c.url ? <EvidenceLink url={c.url}>{c.name}</EvidenceLink> : c.name}
                      </strong>
                      <Pill
                        tone={
                          c.state === "passing" ? "ok" : c.state === "failing" ? "crit" : "warn"
                        }
                      >
                        {c.state}
                      </Pill>
                    </div>
                    <p>
                      {c.conclusion}
                      {c.attempt != null && ` · attempt ${c.attempt}`}
                    </p>
                  </li>
                ))}
              </ul>
            </ReportScroll>
            {!r.ci.checks.length && <p>CI gate results were not recorded.</p>}
          </div>
        </Panel>
      </div>
      <Panel
        id={`qa-tests-${r.id}`}
        title="Tests and command evidence"
        sub="Execution receipts and reported counts are labelled separately"
      >
        <ReportScroll
          label="Recorded test and command evidence"
          className="pb qa-report-test-list qa-report-scroll"
        >
          {r.tests.map((t) => (
            <section key={JSON.stringify(t)}>
              <header>
                <code>{t.command}</code>
                <Pill
                  tone={t.outcome === "failed" ? "crit" : t.outcome === "passed" ? "ok" : "warn"}
                >
                  {t.outcome}
                </Pill>
              </header>
              <p>
                <strong>{t.origin.replaceAll("-", " ")}</strong> · {timestamp(t.at)} · exit{" "}
                {t.exitCode ?? "unknown"}
              </p>
              <p>
                Reported counts: {t.passed ?? "—"} passed · {t.failed ?? "—"} failed ·{" "}
                {t.skipped ?? "—"} skipped{t.file && ` · ${t.file}`}
              </p>
              {t.evidence ? (
                <p>
                  {qaEvidenceUrl(t.evidence) ? (
                    <EvidenceLink url={t.evidence}>Execution evidence</EvidenceLink>
                  ) : (
                    t.evidence
                  )}
                </p>
              ) : (
                <p className="qa-report-note">No retained command receipt linked.</p>
              )}
            </section>
          ))}
          {!r.tests.length && (
            <p>No test execution evidence was recorded. This does not mean no tests were needed.</p>
          )}
        </ReportScroll>
      </Panel>
      <Panel
        id={`qa-visual-${r.id}`}
        title="Visual confirmation"
        sub={
          r.visual.applicability === "not_applicable"
            ? "Not applicable · reason required"
            : r.visual.applicability === "required"
              ? "Before and after required"
              : "Applicability not established"
        }
      >
        <div className="pb uat-pairs">
          <p>
            {r.visual.reason ?? "QA has not recorded why visual evidence does or does not apply."}
          </p>
          {!r.visual.pairs.length && r.visual.applicability !== "not_applicable" && (
            <p className="uat-banner">Before/after pairs are missing from this report.</p>
          )}
          {r.visual.pairs.map((pair) => (
            <section className="uat-pair" key={JSON.stringify(pair)}>
              <h3>{pair.label}</h3>
              <div className="uat-shots">
                <Image image={pair.before} label={`Before · ${pair.label}`} />
                <Image image={pair.after} label={`After · ${pair.label}`} />
              </div>
              {pair.diff && (
                <details>
                  <summary>Pixel diff · {pair.label}</summary>
                  <Image image={pair.diff} label={`Pixel diff · ${pair.label}`} />
                </details>
              )}
            </section>
          ))}
          {!!r.visual.screenshots?.length && (
            <details>
              <summary>Additional QA browser captures ({r.visual.screenshots.length})</summary>
              <div className="uat-shots">
                {r.visual.screenshots.map((s) => (
                  <Image key={JSON.stringify(s)} image={s} label={s.label} />
                ))}
              </div>
            </details>
          )}
        </div>
      </Panel>
      <div className="uat-grid-two">
        <Panel title="What worked well">
          <ul className="pb qa-report-text-list">
            {r.worksWell.map((s) => (
              <li key={s}>{s}</li>
            ))}
            {!r.worksWell.length && <li>No verified positive outcomes were recorded.</li>}
          </ul>
        </Panel>
        <Panel title="Limitations and work not covered">
          <ul className="pb qa-report-text-list">
            {r.limitations.map((s) => (
              <li key={s}>{s}</li>
            ))}
            {!r.limitations.length && <li>No limitations reported in this version.</li>}
          </ul>
        </Panel>
      </div>
      <Panel
        id={`qa-findings-${r.id}`}
        title="Findings and follow-up"
        sub="Retained for rework and later checks"
      >
        <div className="pb uat-stack">
          <ul className="qa-report-text-list">
            {r.findings.map((f) => (
              <li key={JSON.stringify(f)}>
                <strong>
                  {f.severity} · {f.file}:{f.line}
                </strong>
                <p>{f.summary}</p>
                <p>{f.scenario}</p>
                <p>Suggested fix: {f.fix}</p>
              </li>
            ))}
            {!r.findings.length && <li>No findings were reported in this version.</li>}
          </ul>
          {!!r.resolutions.length && (
            <ul className="qa-report-text-list">
              {r.resolutions.map((s) => (
                <li key={`${s.findingRef.reviewId}:${s.findingRef.pos}`}>
                  Review {s.findingRef.reviewId}, finding {s.findingRef.pos}: {s.outcome}
                </li>
              ))}
            </ul>
          )}
          <h3>Follow-up disposition</h3>
          <ul className="qa-report-text-list">
            {r.followUps.map((f) => (
              <li key={JSON.stringify(f)}>
                <strong>{f.disposition}</strong>: {f.text}
                {f.ticket && (
                  <>
                    {" "}
                    ·{" "}
                    {qaEvidenceUrl(f.ticket) ? (
                      <EvidenceLink url={f.ticket}>Ticket reference</EvidenceLink>
                    ) : (
                      f.ticket
                    )}
                  </>
                )}
                {f.basis && <p>{f.basis}</p>}
              </li>
            ))}
            {!r.followUps.length && <li>No follow-ups reported in this version.</li>}
          </ul>
        </div>
      </Panel>
      <p className="qa-report-note">
        Report fingerprint: <code>{r.id}</code>
      </p>
    </article>
  );
});
