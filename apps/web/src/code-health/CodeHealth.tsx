import {
  CODE_HEALTH_OVERVIEW_TTL_MS,
  CODE_HEALTH_WINDOWS,
  type CodeHealthEvidenceRef,
  type CodeHealthOverview,
  type CodeHealthRecommendation,
  type CodeHealthView,
  type CodeHealthWindow,
  type ConfigView,
} from "@mc/core";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { AuditSummary } from "./AuditSummary.tsx";
import { CodeRisk } from "./CodeRisk.tsx";
import { type Action, ActionDialog, EvidenceDialog, HistoryDialog } from "./dialogs.tsx";
import { date, label } from "./format.ts";
import { Categories, Comparison, ReviewRounds } from "./ReviewQuality.tsx";
import { TestHealth } from "./TestHealth.tsx";
import { TokenAudit } from "./TokenAudit.tsx";
import "./code-health.css";

/** Views with their own scope: no repo or window applies, so no code-health read is made. */
const OWN_SCOPE = new Set<string>(["tokens", "history"]);
const Legacy = lazy(() =>
  import("../pages/LegacyAudit.tsx").then((m) => ({ default: m.LegacyAudit })),
);
const TABS = ["summary", "review", "risk", "test", "tokens", "history"] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  summary: "Summary",
  review: "Review quality",
  risk: "Code risk",
  test: "Test health",
  tokens: "Tokens",
  history: "Workflow history",
};
/** A stored summary older than its rebuild interval, plus the grace the full read gets, is shown as stale. */
const SUMMARY_STALE_MS = CODE_HEALTH_OVERVIEW_TTL_MS + 120000;
type Tab = (typeof TABS)[number];
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
    [tab, setTab] = useState<Tab>(() =>
      new URLSearchParams(globalThis.window.location.search).get("tab") === "risk"
        ? "risk"
        : "summary",
    );
  const [last, setLast] = useState<{ path: string; view: CodeHealthView }>(),
    [expired, setExpired] = useState(false);
  const [evidence, setEvidence] = useState<{
    title: string;
    refs: CodeHealthEvidenceRef[];
    coverage?: CodeHealthView["coverage"];
  }>();
  const [action, setAction] = useState<{ row: CodeHealthRecommendation; kind: Action }>(),
    [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false);
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
  const summary = tab === "summary";
  const ref = useMemo(
      () =>
        repo && !OWN_SCOPE.has(tab) && tab !== "summary"
          ? RESOURCES.codeHealth(repo, window, tab)
          : null,
      [repo, window, tab],
    ),
    res = useResource<CodeHealthView>(ref);
  // One shared subscription to the stored first-screen summary; the stream's health topic refreshes it.
  const ovRef = useMemo(
      () => (repo && summary ? RESOURCES.codeHealthOverview(repo, window) : null),
      [repo, window, summary],
    ),
    ovRes = useResource<CodeHealthOverview>(ovRef);
  const [lastOv, setLastOv] = useState<{ path: string; view: CodeHealthOverview }>();
  useEffect(() => {
    if (res.data && ref) setLast({ path: ref.path, view: res.data });
  }, [res.data, ref]);
  useEffect(() => {
    if (ovRes.data && ovRef) setLastOv({ path: ovRef.path, view: ovRes.data });
  }, [ovRes.data, ovRef]);
  const view = res.data ?? (last?.path === ref?.path ? last?.view : undefined);
  const overview = ovRes.data ?? (lastOv?.path === ovRef?.path ? lastOv?.view : undefined);
  // The summary has no coverage list; its evidence and coverage come from the full read, fetched on demand.
  const [wanted, setWanted] = useState<{ title: string; id?: string }>();
  const fullRef = useMemo(
      () => (repo && summary && wanted ? RESOURCES.codeHealth(repo, window, "overview") : null),
      [repo, window, summary, wanted],
    ),
    fullRes = useResource<CodeHealthView>(fullRef);
  useEffect(() => {
    if (!wanted) return;
    if (fullRes.data) {
      const full = fullRes.data,
        row =
          wanted.id !== undefined && full.data.tab === "overview"
            ? full.data.recommendations.find((r) => r.id === wanted.id)
            : undefined;
      setEvidence({
        title: wanted.title,
        refs: wanted.id === undefined ? [] : (row?.evidence ?? []),
        coverage: full.coverage,
      });
      setWanted(undefined);
    } else if (fullRes.error) {
      setNotice(`Evidence could not be read: ${fullRes.error.message} Refresh and try again.`);
      setWanted(undefined);
    }
  }, [wanted, fullRes.data, fullRes.error]);
  const generatedAt = summary ? overview?.generatedAt : view?.generatedAt,
    staleAfter = summary ? SUMMARY_STALE_MS : 120000,
    active = summary ? ovRes : res;
  useEffect(() => {
    setExpired(false);
    if (generatedAt === undefined) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, generatedAt + staleAfter - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [generatedAt, staleAfter]);
  const disconnected = !connected,
    stale =
      expired ||
      (generatedAt !== undefined && Date.now() >= generatedAt + staleAfter) ||
      !!active.error ||
      (!summary &&
        (view?.coverage.some(
          (c) => c.state === "stale" || c.state === "disconnected" || c.state === "error",
        ) ??
          false));
  const configured = !!config.data?.repos.some((row) => row.id === repo) && !config.error;
  const currentSelection = JSON.stringify([repo, window, tab]),
    selection = useRef(currentSelection),
    currentAction = useRef(action);
  selection.current = currentSelection;
  currentAction.current = configured ? action : undefined;
  const blocked = !configured || disconnected || stale || active.loading || !active.data;
  const readRef = summary ? ovRef : ref;
  const retry = () => {
    if (readRef) hub.refetch(readRef.path);
  };
  const changeScope = (next: () => void) => {
    setEvidence(undefined);
    setAction(undefined);
    setWanted(undefined);
    setNotice("");
    setHistory(false);
    next();
  };
  const inspect = (
    title: string,
    refs: CodeHealthEvidenceRef[],
    coverage?: CodeHealthView["coverage"],
  ) => setEvidence({ title, refs, coverage });
  const review = view && view.data.tab === "review" ? view.data.review : undefined;
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
  const coverageButton = () => {
    if (summary) setWanted({ title: "Collection coverage" });
    else if (view) inspect("Collection coverage", [], view.coverage);
  };
  return (
    <section
      id="page-audit"
      className={
        tab === "test" ? "code-health ch-test-page" : summary ? "code-health as-fit" : "code-health"
      }
    >
      <div className="ch-heading">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            Audit
          </h1>
          <p>Where should we invest in code health next?</p>
        </div>
        <div className="ch-filters" hidden={OWN_SCOPE.has(tab)}>
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
      <div className="ch-coverage" hidden={OWN_SCOPE.has(tab)}>
        <strong className={blocked ? "warn-t" : "ok-t"}>
          {disconnected
            ? reconnecting
              ? "Disconnected"
              : "Connecting"
            : stale
              ? "Stale snapshot"
              : active.loading
                ? "Loading"
                : "Connected"}
        </strong>
        <span>
          {generatedAt !== undefined
            ? `Read ${date(generatedAt)}`
            : "Waiting for a bounded code-health read"}
        </span>
        {view && !summary && (
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
        {(summary ? !!overview : !!view) && (
          <button type="button" onClick={coverageButton} disabled={summary && !!wanted}>
            Inspect coverage
          </button>
        )}
        <button type="button" onClick={retry} disabled={!readRef || active.loading}>
          Refresh
        </button>
      </div>
      <div role="tablist" aria-label="Code-health view" className="ch-tabs">
        {TABS.map((t, i) => {
          const props = {
            type: "button" as const,
            role: "tab",
            id: `ch-tab-${t}`,
            "aria-selected": tab === t,
            "aria-controls": "ch-panel",
            tabIndex: tab === t ? 0 : -1,
            ref: (el: HTMLButtonElement | null) => {
              tabRefs.current[i] = el;
            },
            onClick: () => changeScope(() => setTab(t)),
            onKeyDown: (e: React.KeyboardEvent) => {
              let next: number | undefined;
              if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
              if (e.key === "ArrowLeft") next = (i + TABS.length - 1) % TABS.length;
              if (e.key === "Home") next = 0;
              if (e.key === "End") next = TABS.length - 1;
              if (next !== undefined) {
                e.preventDefault();
                tabRefs.current[next]?.click();
                tabRefs.current[next]?.focus();
              }
            },
          };
          // The evidence capture finds this tab by its text (apps/server/test/qa-labels.test.ts).
          return t === "history" ? (
            <button key={t} {...props}>
              Workflow history and earlier proposals
            </button>
          ) : (
            <button key={t} {...props}>
              {TAB_LABEL[t]}
            </button>
          );
        })}
        <span className="ch-links">
          <a href="/audit?tab=risk">Code risk in Audit</a>
          <a href="/qa">PR readiness and tests in QA</a>
          <a href="/telemetry">Cost and flow context</a>
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
      {repo && active.loading && !(summary ? overview : view) && (
        <p role="status" className="ch-notice">
          Loading code-health observations…
        </p>
      )}
      {active.error && (
        <p role="alert" className="ch-notice">
          Collection failed: {active.error.message} Refresh before making decisions.
        </p>
      )}
      {(summary ? overview : view) && blocked && (
        <p className="ch-notice">
          {disconnected
            ? "Connection is unavailable. The last snapshot remains inspectable; actions require reconnection."
            : "The snapshot needs a fresh read before a recommendation can be accepted, dismissed or snoozed."}
        </p>
      )}
      <div
        id="ch-panel"
        role="tabpanel"
        aria-labelledby={`ch-tab-${tab}`}
        aria-busy={active.loading}
      >
        {tab === "tokens" && <TokenAudit />}
        {tab === "history" && (
          <Suspense fallback={<p>Loading workflow history…</p>}>
            <Legacy />
          </Suspense>
        )}
        {overview && summary && (
          <AuditSummary
            key={`${repo}-${window}`}
            overview={overview}
            blocked={blocked}
            onDecide={(row, kind) => setAction({ row, kind })}
            onInspect={(row) => setWanted({ title: "Recommendation evidence", id: row.id })}
            onHistory={() => setHistory(true)}
          />
        )}
        {view && tab === "test" && view.data.tab === "test" && (
          <TestHealth
            data={view.data}
            coverage={view.coverage}
            evidence={view.evidence}
            onInspect={inspect}
            onRecommendations={() => {
              changeScope(() => setTab("summary"));
              tabRefs.current[0]?.focus();
            }}
          />
        )}
        {view && tab === "risk" && view.data.tab === "risk" && (
          <CodeRisk data={view.data} window={window} coverage={view.coverage} onInspect={inspect} />
        )}
        {view && review && tab === "review" && (
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
        )}
      </div>
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
