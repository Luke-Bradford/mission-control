import {
  CODE_HEALTH_OVERVIEW_TTL_MS,
  CODE_HEALTH_WINDOWS,
  type CodeHealthOverview,
  type CodeHealthRecommendation,
  type CodeHealthView,
  type CodeHealthWindow,
  type ConfigView,
} from "@mc/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { DoNext, type Who } from "./AuditDoNext.tsx";
import { HowWeBuild, PastResults, WhereFindingsLand } from "./AuditSide.tsx";
import {
  type Action,
  ActionDialog,
  EvidenceDialog,
  HealthDialog,
  HistoryDialog,
} from "./dialogs.tsx";
import { date, label, message } from "./format.ts";
import "./code-health.css";
import "./audit-overview.css";

/** Every earlier Audit view, each one click from the overview. */
export const AUDIT_VIEWS = [
  { value: "review", label: "Review quality" },
  { value: "risk", label: "Code risk" },
  { value: "test", label: "Test health" },
  { value: "tokens", label: "Tokens" },
  { value: "history", label: "Workflow history" },
] as const;
export type AuditViewName = "overview" | (typeof AUDIT_VIEWS)[number]["value"];
export interface AuditScope {
  repo: string;
  window: CodeHealthWindow;
}

/** The server rebuilds a summary after its TTL; a minute of grace covers the read in flight. */
const STALE_AFTER_MS = CODE_HEALTH_OVERVIEW_TTL_MS + 60_000;
const WINDOW_LABEL: Record<CodeHealthWindow, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};
const VERDICT_WORD = { ok: "On track.", warn: "Needs attention.", unknown: "Cannot judge yet." };

/** The Audit page's first screen, read from one stored summary shared by every panel. */
export function AuditOverview({
  scope,
  onScope,
  onOpen,
}: {
  scope: AuditScope;
  onScope: (scope: AuditScope) => void;
  onOpen: (view: AuditViewName) => void;
}) {
  const { repo, window } = scope;
  const config = useResource<ConfigView>(RESOURCES.config),
    connected = useSyncExternalStore(streamStatus.subscribe, () => streamStatus.get().connected),
    reconnecting = useSyncExternalStore(
      streamStatus.subscribe,
      () => streamStatus.get().reconnecting,
    );
  const [filter, setFilter] = useState<Who>("all"),
    [openId, setOpenId] = useState<string | null | undefined>(undefined),
    [action, setAction] = useState<{ row: CodeHealthRecommendation; kind: Action }>(),
    [evidence, setEvidence] = useState<CodeHealthRecommendation>(),
    [history, setHistory] = useState(false),
    [notice, setNotice] = useState("");
  const [last, setLast] = useState<{ path: string; view: CodeHealthOverview }>(),
    [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);

  // The first configured repo, until the person picks one.
  useEffect(() => {
    if (!config.data) return;
    const repos = config.data.repos;
    if (!repos.some((row) => row.id === repo)) onScope({ repo: repos[0]?.id ?? "", window });
  }, [config.data, repo, window, onScope]);

  const scopeKey = `${repo}|${window}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new scope closes what was open for the old one
  useEffect(() => {
    setAction(undefined);
    setEvidence(undefined);
    setHistory(false);
    setNotice("");
    setOpenId(undefined);
  }, [scopeKey]);

  const ref = useMemo(
      () => (repo ? RESOURCES.codeHealthOverview(repo, window) : null),
      [repo, window],
    ),
    res = useResource<CodeHealthOverview>(ref);
  useEffect(() => {
    if (res.data && ref) setLast({ path: ref.path, view: res.data });
  }, [res.data, ref]);
  // Never the other scope's summary while this one loads or fails.
  const summary = res.data ?? (last?.path === ref?.path ? last?.view : undefined);

  useEffect(() => {
    setNow(Date.now());
    if (!summary) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, summary.generatedAt + STALE_AFTER_MS - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [summary]);

  const disconnected = !connected;
  const expired = !!summary && now >= summary.generatedAt + STALE_AFTER_MS;
  const stale = expired || !!res.error;
  const configured = !!config.data?.repos.some((row) => row.id === repo) && !config.error;
  const blocked = !configured || disconnected || stale || res.loading || !res.data;
  const retry = () => {
    if (ref) hub.refetch(ref.path);
  };

  const rows = summary?.rows ?? [];
  const effectiveOpen = openId === undefined ? (rows[0]?.id ?? null) : openId;
  const status = disconnected
    ? reconnecting
      ? "Disconnected"
      : "Connecting"
    : stale
      ? "Stale summary"
      : res.loading
        ? "Loading"
        : "Connected";

  const selection = useRef(scopeKey),
    currentAction = useRef(action);
  selection.current = scopeKey;
  currentAction.current = configured ? action : undefined;
  const onSaved = (row: CodeHealthRecommendation) => {
    if (
      selection.current !== scopeKey ||
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

  const empty = !configured
    ? config.error
      ? "Configured repos could not be read."
      : config.data && !config.data.repos.length
        ? "No repos are configured. Add a repo in Setup before collecting code-health evidence."
        : "Reading configured repos…"
    : res.error && !summary
      ? `The summary could not be read: ${message(res.error)}`
      : !summary
        ? "Loading the stored Audit summary…"
        : "No open proposal meets the measured triage rules. Missing collection is described in the figures; this is not a healthy-repo verdict.";

  return (
    <section id="page-audit" className="ao" aria-busy={res.loading}>
      <div className="ao-bar">
        <h1 ref={heading} tabIndex={-1}>
          Audit
        </h1>
        <nav aria-label="Audit views" className="ao-views">
          {AUDIT_VIEWS.map((v) => (
            <button type="button" key={v.value} onClick={() => onOpen(v.value)}>
              {v.label}
            </button>
          ))}
          <a href="/telemetry">Cost and flow context</a>
          <a href="/qa">PR readiness and tests in QA</a>
        </nav>
        <span className="sp" />
        <strong className={status === "Connected" ? "ok-t" : "warn-t"}>{status}</strong>
        <span className="ao-read">
          {summary ? `Read ${date(summary.generatedAt)}` : "Waiting for the stored summary"}
        </span>
        <button type="button" onClick={retry} disabled={!ref || res.loading}>
          Refresh
        </button>
      </div>
      <div className="ao-top">
        <p className="ao-verdict">
          {summary ? (
            <>
              <b className={`v-${summary.verdict.tone}`}>{VERDICT_WORD[summary.verdict.tone]}</b>{" "}
              {summary.verdict.text}
            </>
          ) : (
            <span className="m">
              {res.error
                ? "The Audit summary is unavailable."
                : "Reading the stored Audit summary…"}
            </span>
          )}
        </p>
        <div className="ao-ctl">
          <label>
            <span className="micro">Repo</span>
            <select
              value={repo}
              onChange={(e) => onScope({ repo: e.target.value, window })}
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
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and a border the toolbar has no room for */}
          <span className="seg" role="group" aria-label="Code-health window">
            {CODE_HEALTH_WINDOWS.map((w) => (
              <button
                type="button"
                key={w}
                className={window === w ? "on" : ""}
                aria-pressed={window === w}
                onClick={() => onScope({ repo, window: w })}
              >
                {WINDOW_LABEL[w]}
              </button>
            ))}
          </span>
        </div>
      </div>
      {notice && (
        <p role="status" className="ch-notice ao-note">
          {notice}
        </p>
      )}
      {res.error && (
        <p role="alert" className="ch-notice ao-note">
          Collection failed: {res.error.message} Refresh before making decisions.
          {summary ? " The last summary stays below." : ""}
        </p>
      )}
      {summary && blocked && !res.error && (
        <p className="ch-notice ao-note">
          {disconnected
            ? "Connection is unavailable. The last summary remains readable; decisions need the connection back."
            : expired
              ? "This summary is older than the hub keeps it. Refresh before accepting, dismissing or snoozing a proposal."
              : "Reading a fresh summary. Decisions are off until it arrives."}
        </p>
      )}
      <div className="ao-cols">
        <div className="ao-col">
          <DoNext
            rows={rows}
            filter={filter}
            onFilter={setFilter}
            open={effectiveOpen}
            onOpen={setOpenId}
            blocked={blocked}
            empty={empty}
            onAction={(row, kind) => setAction({ row, kind })}
            onEvidence={setEvidence}
            onHistory={() => setHistory(true)}
          />
          <Panel
            className="ao-outside"
            title="New outside"
            sub={
              summary ? (
                <>
                  <b>{summary.outside.items.length}</b> items
                </>
              ) : undefined
            }
          >
            <p className="ao-empty">
              {summary
                ? summary.outside.items.length
                  ? `${summary.outside.items.length} outside items`
                  : summary.outside.note
                : "Not read yet."}
            </p>
          </Panel>
        </div>
        <div className="ao-col">
          {summary ? (
            <>
              <HowWeBuild build={summary.build} figures={summary.figures} />
              <WhereFindingsLand
                landing={summary.landing}
                window={window}
                onOpenRisk={() => onOpen("risk")}
              />
              <PastResults past={summary.past} />
            </>
          ) : (
            <Panel title="How we build">
              <p className="ao-empty">Waiting for the stored summary.</p>
            </Panel>
          )}
        </div>
      </div>
      {evidence && (
        <RowEvidence
          key={`${repo}-${evidence.id}`}
          repo={repo}
          window={window}
          row={evidence}
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
            setEvidence(row);
          }}
        />
      )}
    </section>
  );
}

/** The summary's rows carry no evidence references; the full read serves them, on demand. */
function RowEvidence({
  repo,
  window,
  row,
  onClose,
}: {
  repo: string;
  window: CodeHealthWindow;
  row: CodeHealthRecommendation;
  onClose: () => void;
}) {
  const own = row.evidence.length > 0;
  const res = useResource<CodeHealthView>(
    own ? null : RESOURCES.codeHealth(repo, window, "overview"),
  );
  const full =
    res.data?.data.tab === "overview"
      ? res.data.data.recommendations.find((r) => r.id === row.id)
      : undefined;
  const refs = own ? row.evidence : (full?.evidence ?? []);
  if (refs.length)
    return (
      <EvidenceDialog
        repo={repo}
        title="Recommendation evidence"
        refs={refs}
        coverage={res.data?.coverage}
        onClose={onClose}
      />
    );
  return (
    <HealthDialog title="Recommendation evidence" onClose={onClose}>
      {res.error ? (
        <p role="alert">Evidence could not be read: {res.error.message}</p>
      ) : !res.data ? (
        <p role="status">Loading the evidence references…</p>
      ) : (
        <p role="status">
          This proposal has no stored evidence references in the current read. Its observation is
          the only record: {row.observation}
        </p>
      )}
    </HealthDialog>
  );
}
