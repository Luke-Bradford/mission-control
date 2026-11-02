import type {
  CodeHealthEvidenceRef,
  CodeHealthRecommendation,
  CodeHealthView,
  ConfigView,
} from "@mc/core";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError, apiOperatorGet, apiPost } from "../api.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { trapTab, useOverlay, useReturnFocus } from "../shell/overlays.ts";
import { date, label, message } from "./format.ts";
export type Action = "accept" | "dismiss" | "snooze";
interface EvidencePage {
  reference: CodeHealthEvidenceRef;
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  truncated: boolean;
}
function HealthDialog({
  title,
  onClose,
  busy = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const id = useId(),
    close = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLElement>(null);
  useOverlay(`code-health-${id}`, true, () => {
    if (!busy) onClose();
  });
  useReturnFocus(true);
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the overlay traps Tab and Escape for its named modal dialog.
    <div
      className="modal ch-overlay"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onClose();
        } else if (busy && e.key === "Tab") {
          e.preventDefault();
          dialog.current?.focus();
        } else trapTab(e);
      }}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        className="panel ch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-busy={busy}
      >
        <div className="ph">
          <h2 id={id}>{title}</h2>
          <button ref={close} type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="pb ch-dialog-body">
          {busy && <p role="status">Recording decision… Waiting for server confirmation.</p>}
          {children}
        </div>
      </section>
    </div>
  );
}
export function EvidenceDialog({
  repo,
  title,
  refs,
  coverage,
  onClose,
}: {
  repo: string;
  title: string;
  refs: CodeHealthEvidenceRef[];
  coverage?: CodeHealthView["coverage"];
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0),
    [cursor, setCursor] = useState("0"),
    [previous, setPrevious] = useState<string[]>([]),
    [page, setPage] = useState<EvidencePage>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const config = useResource<ConfigView>(RESOURCES.config),
    github = config.data?.repos.find((r) => r.id === repo)?.github,
    reference = refs[index];
  useEffect(() => {
    if (!reference) return;
    let alive = true;
    setLoading(true);
    setPage(undefined);
    setError("");
    apiOperatorGet<EvidencePage>(RESOURCES.codeHealthEvidence(repo, reference.id, cursor).path)
      .then((value) => {
        if (alive) setPage(value);
      })
      .catch((err) => {
        if (alive) setError(message(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repo, reference, cursor]);
  return (
    <HealthDialog title={title} onClose={onClose}>
      {coverage?.map((c) => (
        <section key={`${c.source}-${c.from}-${c.until}`} className="ch-evidence-item">
          <h3>
            {c.source} · {label(c.state)}
          </h3>
          <p>
            Requested {c.requestedWindow}: {date(c.from)} to {date(c.until)}.
          </p>
          <p>
            Observed {date(c.observedFrom)} to {date(c.observedUntil)}. Analysed SHA{" "}
            {c.analysedSha ?? "not collected"}.
          </p>
          <p className="ch-secondary">{c.note}</p>
        </section>
      ))}
      {!refs.length && !coverage && (
        <p>
          Supporting rows are not collected. This proposal asks for collection; it does not
          establish a measured defect.
        </p>
      )}
      {!!refs.length && (
        <>
          <label>
            Evidence source
            <select
              value={index}
              onChange={(e) => {
                setIndex(Number(e.target.value));
                setCursor("0");
                setPrevious([]);
              }}
            >
              {refs.map((r, i) => (
                <option value={i} key={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <p>{reference?.definition}</p>
          <p className="ch-secondary">
            Evidence window {reference?.coverage.requestedWindow}:{" "}
            {date(reference?.coverage.from ?? null)} to {date(reference?.coverage.until ?? null)}.{" "}
            {reference?.coverage.note}
          </p>
        </>
      )}
      {loading && <p role="status">Loading bounded evidence…</p>}
      {error && (
        <p role="alert">
          Evidence could not be read: {error} Close this drawer and refresh the summary.
        </p>
      )}
      {page && (
        <>
          <p>
            {page.rows.length} {page.rows.length === 1 ? "row" : "rows"} on this page, from row{" "}
            {Number(cursor) + 1}. {page.truncated ? "The bounded evidence limit was reached." : ""}
          </p>
          {!page.rows.length && (
            <p>
              No matching rows were observed for this query. Missing collection is not zero defects.
            </p>
          )}
          <div className="ch-evidence-rows">
            {page.rows.map((row, i) => (
              <details
                key={`${cursor}-${row.findingId ?? row.reviewId ?? row.observationId ?? row.commandRecordId ?? row.path ?? JSON.stringify(row)}`}
                className="ch-evidence-item"
              >
                <summary>
                  {typeof row.pr === "number" ? `PR ${row.pr}` : `Record ${Number(cursor) + i + 1}`}{" "}
                  · {String(row.file ?? row.job ?? row.state ?? row.reviewId ?? "Evidence")}
                </summary>
                <dl>
                  {Object.entries(row).map(([key, value]) => (
                    <div key={key}>
                      <dt>{label(key)}</dt>
                      <dd>
                        {value === null
                          ? "—"
                          : typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {typeof row.pr === "number" &&
                  Number.isSafeInteger(row.pr) &&
                  row.pr > 0 &&
                  github && (
                    <a
                      href={`https://github.com/${github}/pull/${row.pr}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open PR {row.pr}
                    </a>
                  )}
                {typeof row.url === "string" && row.url.startsWith("https://github.com/") && (
                  <a href={row.url} target="_blank" rel="noreferrer">
                    Open source result
                  </a>
                )}
              </details>
            ))}
          </div>
          <div className="ch-actions">
            <button
              type="button"
              disabled={!previous.length || loading}
              onClick={() => {
                setCursor(previous.at(-1) ?? "0");
                setPrevious(previous.slice(0, -1));
              }}
            >
              Previous 50 rows
            </button>
            <button
              type="button"
              disabled={!page.nextCursor || loading}
              onClick={() => {
                if (page.nextCursor) {
                  setPrevious([...previous, cursor]);
                  setCursor(page.nextCursor);
                }
              }}
            >
              Next 50 rows
            </button>
          </div>
        </>
      )}
    </HealthDialog>
  );
}
export function ActionDialog({
  repo,
  row,
  kind,
  blocked,
  onClose,
  onSaved,
}: {
  repo: string;
  row: CodeHealthRecommendation;
  kind: Action;
  blocked: boolean;
  onClose: () => void;
  onSaved: (row: CodeHealthRecommendation) => void;
}) {
  const config = useResource<ConfigView>(RESOURCES.config),
    [owner, setOwner] = useState(config.data?.operator.id ?? ""),
    [reason, setReason] = useState(""),
    [until, setUntil] = useState(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID()),
    attempt = useRef<unknown>(undefined),
    [locked, setLocked] = useState(false),
    alert = useRef<HTMLParagraphElement>(null),
    mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (blocked || busy) return;
    const at = Date.parse(`${until}T00:00:00Z`);
    if (!attempt.current) {
      if (kind === "accept" && !owner.trim()) {
        setError("Enter an owner before accepting.");
        return;
      }
      if (kind === "dismiss" && !reason.trim()) {
        setError("Enter a reason before dismissing.");
        return;
      }
      if (kind !== "dismiss" && (!Number.isFinite(at) || at <= Date.now())) {
        setError("Choose a future date in UTC.");
        return;
      }
      attempt.current = {
        requestId: requestId.current,
        basis: `Operator ${kind} from code-health evidence ${row.evidenceFingerprint}.`,
        expectedUpdatedAt: row.updatedAt,
        change:
          kind === "accept"
            ? { action: kind, owner: owner.trim(), reviewAt: at }
            : kind === "dismiss"
              ? { action: kind, reason: reason.trim() }
              : { action: kind, until: at },
      };
      setLocked(true);
    }
    setBusy(true);
    setError("");
    let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const saved = await Promise.race([
        apiPost<CodeHealthRecommendation>(
          ACTIONS.codeHealthDecision(repo, row.id),
          attempt.current,
        ),
        new Promise<never>((_, reject) => {
          confirmationTimer = setTimeout(
            () => reject(new Error("The server has not confirmed the decision within 15 seconds.")),
            15000,
          );
        }),
      ]);
      if (mounted.current) onSaved(saved);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 400) {
        attempt.current = undefined;
        requestId.current = crypto.randomUUID();
        setLocked(false);
        setError(`${message(err)} Correct the fields before retrying.`);
      } else
        setError(
          `${message(err)} This decision is not confirmed. Retry the same decision, or close and refresh history before changing it.`,
        );
    } finally {
      if (confirmationTimer) clearTimeout(confirmationTimer);
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <HealthDialog
      title={
        kind === "accept"
          ? "Accept proposal"
          : kind === "dismiss"
            ? "Dismiss with a reason"
            : "Snooze proposal"
      }
      onClose={onClose}
      busy={busy}
    >
      <p>{row.proposal}</p>
      <p className="ch-secondary">{row.observation}</p>
      <form onSubmit={submit} noValidate className="ch-form">
        {error && (
          <p ref={alert} tabIndex={-1} role="alert" className="ch-notice">
            {error}
          </p>
        )}
        {kind === "accept" && (
          <label>
            Owner
            <input
              value={owner}
              maxLength={120}
              required
              disabled={busy || locked}
              onChange={(e) => {
                setOwner(e.target.value);
                setError("");
              }}
            />
          </label>
        )}
        {kind === "dismiss" && (
          <label>
            Reason
            <textarea
              value={reason}
              maxLength={2000}
              required
              disabled={busy || locked}
              onChange={(e) => {
                setReason(e.target.value);
                setError("");
              }}
            />
          </label>
        )}
        {kind !== "dismiss" && (
          <label>
            {kind === "accept" ? "Review metric on (UTC)" : "Snooze until (UTC)"}
            <input
              type="date"
              value={until}
              required
              disabled={busy || locked}
              onChange={(e) => {
                setUntil(e.target.value);
                setError("");
              }}
            />
          </label>
        )}
        <p className="ch-secondary">
          {kind === "accept"
            ? "Records an owner and baseline. FLIGHT handles linked work through its existing authorised ticket path; this does not apply code or rules."
            : "The decision stays in recommendation history when evidence refreshes."}
        </p>
        {blocked && <p role="status">Reconnect and refresh before recording a decision.</p>}
        <button type="submit" disabled={blocked || busy}>
          {busy ? "Recording…" : locked ? "Retry this decision" : "Record decision"}
        </button>
      </form>
    </HealthDialog>
  );
}
interface HistoryRow extends CodeHealthRecommendation {
  active?: boolean;
  baseline?: {
    target: CodeHealthRecommendation["target"];
    acceptedAt: number;
    observation?: string;
  } | null;
  linkedWork?: string | null;
  workReady?: boolean;
}
export function HistoryDialog({
  repo,
  onClose,
  onInspect,
}: {
  repo: string;
  onClose: () => void;
  onInspect: (row: CodeHealthRecommendation) => void;
}) {
  const [cursor, setCursor] = useState("0"),
    [stack, setStack] = useState<string[]>([]),
    [rows, setRows] = useState<HistoryRow[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setRows([]);
    setError("");
    apiOperatorGet<{ recommendations: HistoryRow[]; nextCursor: string | null }>(
      RESOURCES.codeHealthHistory(repo, cursor).path,
    )
      .then((value) => {
        if (alive) {
          setRows(value.recommendations);
          setNext(value.nextCursor);
        }
      })
      .catch((err) => {
        if (alive) setError(message(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repo, cursor]);
  return (
    <HealthDialog title="Recommendation history" onClose={onClose}>
      {loading && <p role="status">Loading recorded decisions…</p>}
      {error && <p role="alert">History could not be read: {error}</p>}
      {!loading && !error && !rows.length && (
        <p>No recommendations have been recorded for this repo.</p>
      )}
      {rows.map((row) => (
        <article key={row.id} className="ch-evidence-item">
          <h3>
            {label(row.state.kind)} · {row.proposal}
          </h3>
          <p>{row.observation}</p>
          {row.state.kind === "accepted" && (
            <p>
              Owner {row.state.owner}; metric review {date(row.state.reviewAt)}.
            </p>
          )}
          {row.state.kind === "dismissed" && <p>Reason: {row.state.reason}</p>}
          {row.state.kind === "snoozed" && <p>Snoozed until {date(row.state.until)}.</p>}
          {row.state.kind === "paid-off" && <p>Assessment: {row.state.assessment}</p>}
          {row.state.kind === "no-effect" && <p>Assessment: {row.state.reason}</p>}
          <button type="button" onClick={() => onInspect(row)}>
            Inspect recorded evidence
          </button>
          {row.baseline && (
            <p className="ch-secondary">
              Accepted baseline: {row.baseline.target.baseline ?? "not measured"} ·{" "}
              {row.baseline.target.metric}; recorded {date(row.baseline.acceptedAt)}.
            </p>
          )}
          {row.linkedWork?.startsWith("https://github.com/") ? (
            <p>
              <a href={row.linkedWork} target="_blank" rel="noreferrer">
                Open linked work
              </a>{" "}
              ·{" "}
              {row.state.kind !== "accepted"
                ? "Assessment recorded"
                : row.workReady
                  ? "Handoff recorded"
                  : "Board handoff pending"}
            </p>
          ) : (
            row.state.kind === "accepted" && (
              <p className="ch-secondary">FLIGHT work is pending; no linked issue is recorded.</p>
            )
          )}
        </article>
      ))}
      <div className="ch-actions">
        <button
          type="button"
          disabled={!stack.length || loading}
          onClick={() => {
            setCursor(stack.at(-1) ?? "0");
            setStack(stack.slice(0, -1));
          }}
        >
          Previous 50
        </button>
        <button
          type="button"
          disabled={!next || loading}
          onClick={() => {
            if (next) {
              setStack([...stack, cursor]);
              setCursor(next);
            }
          }}
        >
          Next 50
        </button>
      </div>
    </HealthDialog>
  );
}
