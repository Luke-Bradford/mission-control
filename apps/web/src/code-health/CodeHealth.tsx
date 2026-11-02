import {
  CODE_HEALTH_WINDOWS,
  type CodeHealthEvidenceRef,
  type CodeHealthRecommendation,
  type CodeHealthView,
  type CodeHealthWindow,
  type ConfigView,
} from "@mc/core";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { type Action, ActionDialog, EvidenceDialog, HistoryDialog } from "./dialogs.tsx";
import { date, label } from "./format.ts";
import { Categories, Comparison, ReviewRounds } from "./ReviewQuality.tsx";
import "./code-health.css";

const Legacy = lazy(() =>
  import("../pages/LegacyAudit.tsx").then((m) => ({ default: m.LegacyAudit })),
);
type Tab = "overview" | "review";
/** The shared operator question, with one bounded read for the selected repo/window/tab. */
export function CodeHealth() {
  const config = useResource<ConfigView>(RESOURCES.config),
    connected = useSyncExternalStore(streamStatus.subscribe, () => streamStatus.get().connected),
    reconnecting = useSyncExternalStore(
      streamStatus.subscribe,
      () => streamStatus.get().reconnecting,
    );
  const [repo, setRepo] = useState(""),
    [window, setWindow] = useState<CodeHealthWindow>("30d"),
    [tab, setTab] = useState<Tab>("overview");
  const [last, setLast] = useState<{ path: string; view: CodeHealthView }>(),
    [expired, setExpired] = useState(false);
  const [evidence, setEvidence] = useState<{
    title: string;
    refs: CodeHealthEvidenceRef[];
    coverage?: CodeHealthView["coverage"];
  }>();
  const [action, setAction] = useState<{ row: CodeHealthRecommendation; kind: Action }>(),
    [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false),
    [legacy, setLegacy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null),
    tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!config.data) return;
    const repos = config.data.repos;
    if (!repos.some((row) => row.id === repo)) {
      const next = repos[0]?.id ?? "";
      if (next !== repo) {
        setRepo(next);
        setAction(undefined);
        setEvidence(undefined);
        setHistory(false);
        setNotice("");
      }
    }
  }, [config.data, repo]);
  const ref = useMemo(
      () => (repo ? RESOURCES.codeHealth(repo, window, tab) : null),
      [repo, window, tab],
    ),
    res = useResource<CodeHealthView>(ref);
  useEffect(() => {
    if (res.data && ref) setLast({ path: ref.path, view: res.data });
  }, [res.data, ref]);
  const view = res.data ?? (last?.path === ref?.path ? last?.view : undefined);
  useEffect(() => {
    setExpired(false);
    if (!view) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, view.generatedAt + 120000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view]);
  const disconnected = !connected,
    stale =
      expired ||
      (!!view && Date.now() >= view.generatedAt + 120000) ||
      !!res.error ||
      (view?.coverage.some(
        (c) => c.state === "stale" || c.state === "disconnected" || c.state === "error",
      ) ??
        false);
  const configured = !!config.data?.repos.some((row) => row.id === repo) && !config.error;
  const currentSelection = JSON.stringify([repo, window, tab]),
    selection = useRef(currentSelection),
    currentAction = useRef(action);
  selection.current = currentSelection;
  currentAction.current = configured ? action : undefined;
  const blocked = !configured || disconnected || stale || res.loading || !res.data;
  const retry = () => {
    if (ref) hub.refetch(ref.path);
  };
  const changeScope = (next: () => void) => {
    setEvidence(undefined);
    setAction(undefined);
    setNotice("");
    setHistory(false);
    next();
  };
  const inspect = (
    title: string,
    refs: CodeHealthEvidenceRef[],
    coverage?: CodeHealthView["coverage"],
  ) => setEvidence({ title, refs, coverage });
  const review =
    view && (view.data.tab === "overview" || view.data.tab === "review")
      ? view.data.review
      : undefined;
  const observed =
    view?.coverage.filter(
      (c) => c.source !== "recommendations" && c.observedFrom !== null && c.observedUntil !== null,
    ) ?? [];
  const observedFrom = observed.length
      ? Math.min(...observed.map((c) => c.observedFrom ?? Infinity))
      : null,
    observedUntil = observed.length ? Math.max(...observed.map((c) => c.observedUntil ?? 0)) : null;
  const shortDate = (at: number | null) =>
    at === null
      ? "not observed"
      : new Date(at).toLocaleDateString("en-GB", { timeZone: "UTC", dateStyle: "medium" });
  const sourceAge =
    observedUntil === null || !view
      ? null
      : Math.max(0, Math.floor((view.generatedAt - observedUntil) / 60000));
  const analysed = [
    ...new Set(
      view?.coverage.flatMap((c) => (c.analysedSha ? [c.analysedSha.slice(0, 8)] : [])) ?? [],
    ),
  ];
  const onSaved = (row: CodeHealthRecommendation) => {
    if (
      selection.current !== currentSelection ||
      currentAction.current !== action ||
      row.repoId !== repo ||
      row.id !== action?.row.id
    )
      return;
    setAction(undefined);
    setNotice(
      `Decision recorded: ${label(row.state.kind)}. ${row.state.kind === "accepted" ? "FLIGHT work is pending through its authorised ticket path." : "The decision is retained in recommendation history."}`,
    );
    retry();
    hub.refetch(RESOURCES.codeHealthHistory(repo).path);
    heading.current?.focus();
  };
  return (
    <section id="page-audit" className="code-health">
      <div className="ch-heading">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            Audit
          </h1>
          <p>Where should we invest in code health next?</p>
        </div>
        <div className="ch-filters">
          <label>
            Repo
            <select
              value={repo}
              onChange={(e) => changeScope(() => setRepo(e.target.value))}
              disabled={!config.data?.repos.length}
            >
              {!config.data?.repos.length && <option value="">No configured repos</option>}
              {config.data?.repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="ch-window">
            <legend className="sr-only">Code-health window</legend>
            {CODE_HEALTH_WINDOWS.map((w) => (
              <button
                type="button"
                key={w}
                aria-pressed={window === w}
                onClick={() => changeScope(() => setWindow(w))}
              >
                {w.slice(0, -1)} days
              </button>
            ))}
          </fieldset>
        </div>
      </div>
      <div className="ch-coverage">
        <strong className={blocked ? "warn-t" : "ok-t"}>
          {disconnected
            ? reconnecting
              ? "Disconnected"
              : "Connecting"
            : stale
              ? "Stale snapshot"
              : res.loading
                ? "Loading"
                : "Connected"}
        </strong>
        <span>
          {view ? `Read ${date(view.generatedAt)}` : "Waiting for a bounded code-health read"}
        </span>
        {view && (
          <>
            <span>
              Observed {shortDate(observedFrom)} to {shortDate(observedUntil)} UTC
            </span>
            <span>
              Newest observation age at read:{" "}
              {sourceAge === null
                ? "not collected"
                : sourceAge < 60
                  ? `${sourceAge} min`
                  : `${Math.floor(sourceAge / 60)} h`}
            </span>
            <span>Analysed SHA: {analysed.length ? analysed.join(", ") : "not collected"}</span>
          </>
        )}
        {view && (
          <button type="button" onClick={() => inspect("Collection coverage", [], view.coverage)}>
            Inspect coverage
          </button>
        )}
        <button type="button" onClick={retry} disabled={!ref || res.loading}>
          Refresh
        </button>
      </div>
      <div role="tablist" aria-label="Code-health view" className="ch-tabs">
        {(["overview", "review"] as const).map((t, i) => (
          <button
            type="button"
            key={t}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            id={`ch-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="ch-panel"
            tabIndex={tab === t ? 0 : -1}
            onClick={() => changeScope(() => setTab(t))}
            onKeyDown={(e) => {
              let next: number | undefined;
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") next = 1 - i;
              if (e.key === "Home") next = 0;
              if (e.key === "End") next = 1;
              if (next !== undefined) {
                e.preventDefault();
                tabRefs.current[next]?.click();
                tabRefs.current[next]?.focus();
              }
            }}
          >
            {t === "overview" ? "Overview" : "Review quality"}
          </button>
        ))}
        <span className="ch-links">
          <a href="/map">File risk in Map</a>
          <a href="/qa">PR readiness and tests in QA</a>
        </span>
      </div>
      {notice && (
        <p role="status" className="ch-notice">
          {notice}
        </p>
      )}
      {config.error && (
        <p role="alert">Configured repos could not be read: {config.error.message}</p>
      )}
      {config.data && !config.data.repos.length && (
        <p className="ch-notice">
          No repos are configured. Add a repo in Setup before collecting code-health evidence.
        </p>
      )}
      {repo && res.loading && !view && (
        <p role="status" className="ch-notice">
          Loading code-health observations…
        </p>
      )}
      {res.error && (
        <p role="alert" className="ch-notice">
          Collection failed: {res.error.message} Refresh before making decisions.
        </p>
      )}
      {view && blocked && (
        <p className="ch-notice">
          {disconnected
            ? "Connection is unavailable. The last snapshot remains inspectable; actions require reconnection."
            : "The snapshot needs a fresh read before a recommendation can be accepted, dismissed or snoozed."}
        </p>
      )}
      <div id="ch-panel" role="tabpanel" aria-labelledby={`ch-tab-${tab}`} aria-busy={res.loading}>
        {view &&
          review &&
          (tab === "overview" && view.data.tab === "overview" ? (
            <div className="ch-layout">
              <Panel
                title="Recommended next actions"
                sub="Conservative 30-day triage; evidence precedes a decision"
              >
                <div className="ch-recommendations">
                  {!view.data.recommendations.length && (
                    <p>
                      No open proposal meets the measured triage rules. Missing collection is
                      described in coverage; this is not a healthy-repo verdict.
                    </p>
                  )}
                  {view.data.recommendations.map((row, i) => (
                    <article key={row.id} className="ch-recommendation">
                      <div className="ch-kicker">
                        {i + 1} · {label(row.rule)} <span>Proposed</span>
                      </div>
                      <ProposalText text={row.proposal} />
                      <ReadableText text={row.observation} />
                      <ReadableText text={row.uncertainty} secondary />
                      <p className="ch-secondary">Rank: {row.rankingReason}</p>
                      <p className="ch-secondary">
                        Target: {row.target.direction} {row.target.metric}; baseline{" "}
                        {row.target.baseline ?? "not measured"}.
                      </p>
                      <div className="ch-actions">
                        <button
                          type="button"
                          onClick={() =>
                            inspect("Recommendation evidence", row.evidence, view.coverage)
                          }
                        >
                          Inspect evidence
                        </button>
                        {(["accept", "dismiss", "snooze"] as const).map((kind) => (
                          <button
                            type="button"
                            key={kind}
                            disabled={blocked}
                            onClick={() => setAction({ row, kind })}
                          >
                            {kind[0].toUpperCase() + kind.slice(1)}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                  <button type="button" onClick={() => setHistory(true)}>
                    Recommendation history
                  </button>
                </div>
              </Panel>
              <div className="ch-stack">
                <ReviewRounds
                  review={review}
                  onInspect={() =>
                    inspect(
                      "Reported review cohort",
                      view.evidence.filter((e) => e.label === "Reported review cohort"),
                    )
                  }
                />
                <Comparison />
              </div>
            </div>
          ) : (
            <div className="ch-layout">
              <ReviewRounds
                review={review}
                onInspect={() =>
                  inspect(
                    "Reported review cohort",
                    view.evidence.filter((e) => e.label === "Reported review cohort"),
                  )
                }
              />
              <div className="ch-stack">
                <Categories
                  review={review}
                  onInspect={() =>
                    inspect(
                      "Finding categories and resolutions",
                      view.evidence.filter((e) => e.label === "Finding categories and resolutions"),
                    )
                  }
                />
                <Comparison />
              </div>
            </div>
          ))}
      </div>
      <div className="ch-footer">
        <a href="/telemetry">Cost and flow context</a>
        <button type="button" aria-expanded={legacy} onClick={() => setLegacy(!legacy)}>
          Workflow history and earlier proposals
        </button>
      </div>
      {legacy && (
        <Suspense fallback={<p>Loading workflow history…</p>}>
          <Legacy />
        </Suspense>
      )}
      {evidence && (
        <EvidenceDialog
          key={`${repo}-${evidence.title}`}
          repo={repo}
          {...evidence}
          onClose={() => setEvidence(undefined)}
        />
      )}
      {action && action.row.repoId === repo && (
        <ActionDialog
          key={`${repo}-${action.row.id}-${action.kind}`}
          repo={repo}
          {...action}
          blocked={blocked}
          onClose={() => setAction(undefined)}
          onSaved={onSaved}
        />
      )}
      {history && (
        <HistoryDialog
          key={repo}
          repo={repo}
          onClose={() => setHistory(false)}
          onInspect={(row) => {
            setHistory(false);
            setEvidence({ title: "Recorded recommendation evidence", refs: row.evidence });
          }}
        />
      )}
    </section>
  );
}
function ReadableText({ text, secondary = false }: { text: string; secondary?: boolean }) {
  return text.length <= 220 ? (
    <p className={secondary ? "ch-secondary" : undefined}>{text}</p>
  ) : (
    <details className="ch-long">
      <summary>{text.slice(0, 160)}… Read full text</summary>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded full-text region needs keyboard scrolling. */}
      <section className="ch-full-text" tabIndex={0} aria-label="Full evidence text">
        {text}
      </section>
    </details>
  );
}
function ProposalText({ text }: { text: string }) {
  return text.length <= 220 ? (
    <h3>{text}</h3>
  ) : (
    <>
      <h3>{text.slice(0, 180)}…</h3>
      <details className="ch-long">
        <summary>Read full proposed action</summary>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded full-text region needs keyboard scrolling. */}
        <section className="ch-full-text" tabIndex={0} aria-label="Full proposed action">
          {text}
        </section>
      </details>
    </>
  );
}
