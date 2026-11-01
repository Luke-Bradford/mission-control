import {
  COMMS_CAPCOM,
  COMMS_MESSAGE_MAX,
  EVIDENCE_PAGE_PATHS,
  type EvidenceManifest,
  type PrUatView,
  type PullRequestSummary,
  type PullRequestView,
  type ReviewShotView,
} from "@mc/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { apiPost, apiReviewImage } from "../api.ts";
import { useNow } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { hub, streamStatus, useResource } from "../data.ts";
import { elapsed, plural, prLabel, shortSha } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { mapPath, navigate, useSearch } from "../router.ts";
import { useStore } from "../shell/store.ts";
import "./qa-readiness.css";

type Queue = { prs: PullRequestSummary[]; flightId: string | null };
const EMPTY: PullRequestSummary[] = [];
const QA_TOPICS = ["boards", "agents"] as const;
const enc = encodeURIComponent;
const keyOf = (p: PullRequestSummary) => `${p.repoId}:${p.number}`;
const qaPath = (p: PullRequestSummary) => `/qa?repo=${enc(p.repoId)}&pr=${p.number}`;
const refresh = () => {
  hub.refetchTopic("boards");
  hub.refetchTopic("agents");
};

/** One queue read; detailed evidence loads only for the selected head. */
export function QaReadiness() {
  const queue = useResource<Queue>({ path: "/api/qa/queue", topic: QA_TOPICS });
  const connection = useStore(streamStatus);
  const search = useSearch();
  const now = useNow();
  const prs = queue.data?.prs ?? EMPTY;
  const waiting = useMemo(
    () =>
      prs
        .filter((p) => p.uat)
        .sort(
          (a, b) =>
            (a.uat?.since ?? Infinity) - (b.uat?.since ?? Infinity) ||
            a.createdAt - b.createdAt ||
            a.number - b.number,
        ),
    [prs],
  );
  const review = useMemo(
    () =>
      prs.filter((p) => !p.uat).sort((a, b) => a.createdAt - b.createdAt || a.number - b.number),
    [prs],
  );
  const params = new URLSearchParams(search);
  const selected =
    prs.find((p) => p.repoId === params.get("repo") && String(p.number) === params.get("pr")) ??
    waiting[0] ??
    review[0];
  return (
    <section id="page-qa-readiness" className="uat-page">
      <header className="uat-title">
        <h1>QA · Waiting for your acceptance</h1>
        <p>
          Evidence, rework and try-it commands for each pull request. Waiting ages start when it
          enters acceptance.
        </p>
      </header>
      {!connection.connected && (
        <p className="uat-banner" role="status">
          Disconnected from the hub. Decisions and messages are disabled until it reconnects.
        </p>
      )}
      {queue.error && (
        <p className="uat-banner crit-t" role="alert">
          {queue.data ? "Showing the last queue. " : "The queue did not load. "}
          {queue.error.message}{" "}
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </p>
      )}
      <div className="uat-layout">
        <Panel
          title="Queue"
          sub={`${waiting.length} in UAT · ${review.length} in review`}
          className="uat-queue"
        >
          {queue.loading && !queue.data && (
            <p className="pb" role="status">
              Loading the acceptance queue…
            </p>
          )}
          {!queue.loading && !queue.error && !waiting.length && (
            <div className="pb uat-empty">
              <h3>Nothing is waiting for you</h3>
              <p>
                {review.length
                  ? "Work still in review is listed below. Pick a PR to inspect its evidence."
                  : "The next PR to reach acceptance will appear here."}
              </p>
            </div>
          )}
          <QueueGroup title="Waiting for you" prs={waiting} selected={selected} now={now} waiting />
          <QueueGroup title="Also in review" prs={review} selected={selected} now={now} />
        </Panel>
        {selected ? (
          <Detail
            key={`${keyOf(selected)}:${selected.headSha}`}
            pr={selected}
            flightId={queue.data?.flightId ?? null}
            enabled={connection.connected && !queue.error}
            now={now}
          />
        ) : (
          <div className="uat-empty panel">
            <h2>Pick a pull request</h2>
            <p>Its evidence will appear here.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function QueueGroup({
  title,
  prs,
  selected,
  now,
  waiting = false,
}: {
  title: string;
  prs: PullRequestSummary[];
  selected: PullRequestSummary | undefined;
  now: number;
  waiting?: boolean;
}) {
  return (
    <section className="uat-queue-group">
      <header>
        <h3>{title}</h3>
        <span>{waiting ? "oldest first" : "not yours yet"}</span>
      </header>
      <ul aria-label={waiting ? "Pull requests in UAT, oldest first" : "Pull requests in review"}>
        {prs.map((p) => (
          <li key={keyOf(p)}>
            <a
              className="uat-queue-row"
              href={qaPath(p)}
              aria-current={selected && keyOf(p) === keyOf(selected) ? "true" : undefined}
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey && e.button === 0) {
                  e.preventDefault();
                  navigate(qaPath(p));
                }
              }}
            >
              <span className="uat-queue-title">{p.title}</span>
              <span
                className="uat-age"
                title={
                  p.uat?.since
                    ? `Waiting since ${new Date(p.uat.since).toLocaleString()}`
                    : undefined
                }
              >
                {waiting
                  ? p.uat?.since == null
                    ? "Age unknown"
                    : elapsed(Math.max(0, now - p.uat.since))
                  : (p.ci ?? "In review")}
              </span>
              <span className="uat-queue-meta">
                {p.repoId} · {prLabel(p.number)} ·{" "}
                {waiting ? "" : p.isDraft ? "Draft" : "In review"}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {!prs.length && (
        <p className="uat-queue-none">
          {waiting ? "No PR is waiting for acceptance." : "No other open PRs."}
        </p>
      )}
    </section>
  );
}

function Detail({
  pr,
  flightId,
  enabled,
  now,
}: {
  pr: PullRequestSummary;
  flightId: string | null;
  enabled: boolean;
  now: number;
}) {
  const detail = useResource<PrUatView>({
    path: `/api/qa/uat/${enc(pr.repoId)}/${pr.number}?head=${enc(pr.headSha ?? "")}`,
    topic: QA_TOPICS,
  });
  const full = useResource<PullRequestView>({
    path: `/api/repos/${enc(pr.repoId)}/prs/${pr.number}?head=${enc(pr.headSha ?? "")}`,
    topic: "boards",
  });
  const evidence = useResource<EvidenceManifest>(
    pr.headSha
      ? {
          path: `/api/prs/${pr.number}/evidence?repo=${enc(pr.repoId)}&sha=${enc(pr.headSha)}`,
          topic: QA_TOPICS,
        }
      : null,
  );
  const data = detail.data;
  const disabled =
    !enabled ||
    detail.error !== null ||
    full.error !== null ||
    data?.sha !== pr.headSha ||
    full.data?.headSha !== pr.headSha;
  const pairs = evidence.data?.sha === pr.headSha ? evidence.data : undefined;
  return (
    <div className="uat-detail">
      <Panel title={`${pr.repoId} · ${prLabel(pr.number)}`} className="uat-decision-panel">
        <div className="pb uat-stack">
          <Decide
            pr={pr}
            disabled={disabled}
            waiting={Boolean(pr.uat && data?.uat.waiting)}
            summary={data?.qaSummary ?? "No review summary has been captured for this head."}
          >
            <div>
              <h2>{pr.title}</h2>
              <div className="uat-meta">
                <span>{pr.branch}</span>
                <span>head {shortSha(pr.headSha ?? "")}</span>
                <span>CI: {pr.ci ?? "not captured"}</span>
                {full.data?.changedFiles != null && (
                  <span>
                    {plural(full.data.changedFiles, "file")} · +{full.data.additions ?? "—"} −
                    {full.data.deletions ?? "—"}
                  </span>
                )}
              </div>
            </div>
          </Decide>
          {detail.loading && !data && <p role="status">Loading this PR’s evidence…</p>}
          {(detail.error || full.error) && (
            <p className="crit-t" role="alert">
              Could not load this head’s details. {detail.error?.message ?? full.error?.message}{" "}
              <button type="button" onClick={refresh}>
                Try again
              </button>
            </p>
          )}
          {data?.uat.note && (
            <p className="uat-banner">
              <strong>Sent back:</strong> {data.uat.note}
            </p>
          )}
          <ExternalLink url={pr.url} label={`Open ${prLabel(pr.number)} on GitHub`}>
            Open PR on GitHub
          </ExternalLink>
        </div>
      </Panel>
      <Pairs pr={pr} manifest={pairs} loading={evidence.loading} />
      <div className="uat-grid-two uat-tests-grid">
        <Tests data={data} checks={full.data?.checks ?? []} />
        <Panel title="Rework timeline">
          <ol className="pb uat-rounds">
            {data?.rounds.map((r) => (
              <li key={r.reviewId}>
                <header>
                  <strong>Round {r.round}</strong>
                  <span>{shortSha(r.sha)}</span>
                  <Pill tone={r.result === "open" ? "warn" : "ok"}>{r.result}</Pill>
                </header>
                {r.blocking.map((f) => (
                  <p key={`${f.file}:${f.line}:${f.summary}`}>
                    {f.severity}: {f.summary}
                  </p>
                ))}
                {r.reply && (
                  <p>
                    <strong>{r.reply.from}:</strong> {r.reply.text}
                  </p>
                )}
                {r.fixSha && <p>Fix commit {shortSha(r.fixSha)}</p>}
              </li>
            ))}
            {!data?.rounds.length && <li>No completed review rounds captured.</li>}
          </ol>
        </Panel>
      </div>
      <div className="uat-grid-two">
        <Panel title="Impact">
          <div className="pb uat-stack">
            <p>
              {data?.files?.length
                ? `${plural(data.files.length, "changed file")}. Open the Map with this PR’s files selected.`
                : "Changed paths have not been captured."}
            </p>
            {data?.files?.length ? (
              <>
                <ul className="uat-files">
                  {data.files.slice(0, 6).map((file) => (
                    <li key={file} title={file}>
                      {file}
                    </li>
                  ))}
                </ul>
                <a href={`${mapPath(pr.repoId)}?pr=${pr.number}`}>Open in Map with these files</a>
              </>
            ) : null}
          </div>
        </Panel>
        <Panel title="Try it">
          <div className="pb uat-stack">
            <p className="uat-meta">Branch {data?.tryIt.branch ?? pr.branch}</p>
            {data?.tryIt.commands.length ? (
              <pre>{data.tryIt.commands.join("\n")}</pre>
            ) : (
              <p>Run commands have not been captured.</p>
            )}
            {data?.tryIt.previewUrl && /^https?:\/\//.test(data.tryIt.previewUrl) ? (
              <a href={data.tryIt.previewUrl} target="_blank" rel="noopener noreferrer">
                Open preview
              </a>
            ) : (
              <p>No preview is running for this PR.</p>
            )}
          </div>
        </Panel>
      </div>
      {data?.screenshots?.length ? (
        <Panel title="QA’s browser checks">
          <div className="pb uat-review-shots">
            {data.screenshots.map((shot) => (
              <ReviewImage key={shot.id} shot={shot} />
            ))}
          </div>
        </Panel>
      ) : null}
      <Thread pr={pr} data={data} flightId={flightId} disabled={disabled} now={now} />
    </div>
  );
}

function Decide({
  pr,
  disabled,
  waiting,
  children,
  summary,
}: {
  pr: PullRequestSummary;
  disabled: boolean;
  waiting: boolean;
  children: ReactNode;
  summary: string;
}) {
  const [open, setOpen] = useState(false),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const pending = useRef(false);
  async function decide(action: "accept" | "send_back") {
    if (
      disabled ||
      !waiting ||
      !pr.headSha ||
      pending.current ||
      done ||
      (action === "send_back" && !note.trim())
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await apiPost(`/api/prs/${enc(pr.repoId)}/${pr.number}/uat`, {
        action,
        sha: pr.headSha,
        ...(action === "send_back" ? { note: note.trim() } : {}),
      });
      setDone(true);
      setOpen(false);
      setMessage(
        action === "accept"
          ? "Accepted for this head. The hub can merge it when its remaining checks pass."
          : "Sent back with your note. The author’s next round will appear here.",
      );
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision could not be saved.");
      refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="uat-detail-head">
        {children}
        <div className="uat-actions-area">
          <fieldset className="uat-actions" aria-label="Decide">
            <button
              type="button"
              className="uat-accept"
              disabled={disabled || !waiting || busy || done}
              onClick={() => void decide("accept")}
            >
              Accept
            </button>
            <button
              type="button"
              className="uat-send"
              disabled={disabled || !waiting || busy || done}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              Send back…
            </button>
          </fieldset>
          {!waiting && !done && <p className="uat-meta">This PR is still in review.</p>}
        </div>
      </div>
      <p>
        <strong>QA:</strong> {summary}
      </p>
      {open && (
        <form
          className="uat-send-form"
          onSubmit={(e) => {
            e.preventDefault();
            void decide("send_back");
          }}
        >
          <label>
            Note to the author (required)
            <textarea
              value={note}
              required
              maxLength={COMMS_MESSAGE_MAX}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="uat-actions">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="uat-send" disabled={disabled || busy || !note.trim()}>
              Send back with this note
            </button>
          </div>
        </form>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="crit-t">
          {error}
        </p>
      )}
    </>
  );
}

function Pairs({
  pr,
  manifest,
  loading,
}: {
  pr: PullRequestSummary;
  manifest: EvidenceManifest | undefined;
  loading: boolean;
}) {
  return (
    <Panel title="Before and after" sub="per affected page · captured at PR head">
      <div className="pb uat-pairs">
        {!manifest?.pairs.length ? (
          <p className="uat-no-capture">
            {loading
              ? "Loading screenshot evidence…"
              : "No before/after pairs have been captured for this head. Ask QA about missing evidence before deciding."}
          </p>
        ) : (
          manifest.pairs.map((pair) => {
            const base = `/api/prs/${pr.number}/evidence/${manifest.sha}/${pair.page}-${pair.scheme}`;
            return (
              <section className="uat-pair" key={`${pair.page}:${pair.scheme}`}>
                <h3>
                  {pair.page.replace(/_/g, " · ")}{" "}
                  <span>
                    {EVIDENCE_PAGE_PATHS[pair.page]} · 1600×1000 · {pair.scheme}
                  </span>
                  <Pill tone={pair.changedPixels ? "warn" : "ok"}>
                    {pair.changedPixels
                      ? `${pair.changedPercent.toFixed(2)}% changed`
                      : "No visual change"}
                  </Pill>
                </h3>
                <div className="uat-shots">
                  {(["before", "after"] as const).map((kind) => (
                    <figure key={kind}>
                      <figcaption>
                        {kind === "before" ? "Before" : "After"}
                        <span>
                          {kind === "before"
                            ? `main ${shortSha(manifest.mainSha)}`
                            : `head ${shortSha(manifest.sha)}`}
                        </span>
                      </figcaption>
                      <a
                        href={`${base}-${kind}.png?repo=${enc(pr.repoId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <img
                          src={`${base}-${kind}.png?repo=${enc(pr.repoId)}`}
                          alt={`${pair.page}, ${pair.scheme}, ${kind}`}
                          loading="lazy"
                        />
                      </a>
                    </figure>
                  ))}
                </div>
                <a
                  href={`${base}-diff.png?repo=${enc(pr.repoId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open pixel diff · {plural(pair.regions.length, "changed region")}
                </a>
              </section>
            );
          })
        )}
      </div>
    </Panel>
  );
}

function Tests({
  data,
  checks,
}: {
  data: PrUatView | undefined;
  checks: NonNullable<PullRequestView["checks"]>;
}) {
  return (
    <Panel title="Tests run" sub="reported on this head">
      <div className="uat-scroll">
        <table className="uat-table">
          <thead>
            <tr>
              <th scope="col">Suite or command</th>
              <th scope="col">Passed</th>
              <th scope="col">Failed</th>
              <th scope="col">New</th>
            </tr>
          </thead>
          <tbody>
            {data?.tests?.map((t) => (
              <tr key={`${t.command}:${t.file ?? ""}`}>
                <td title={t.file ?? t.command}>{t.file ?? t.command}</td>
                <td className="ok-t">{t.passed}</td>
                <td className={t.failed ? "crit-t" : undefined}>{t.failed}</td>
                <td>—</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.tests?.length && (
          <p className="pb">Test counts have not been captured for this head.</p>
        )}
        {Boolean(data?.tests?.length) && (
          <p className="pb">
            New test counts have not been captured.
            {data?.testsAdded?.length
              ? ` ${plural(data.testsAdded.length, "added test file")} reported.`
              : ""}
          </p>
        )}
      </div>
      {checks.length ? (
        <div className="pb uat-checks">
          {checks.map((check) => (
            <Pill
              key={`${check.name}:${check.kind}`}
              tone={check.state === "passing" ? "ok" : check.state === "failing" ? "crit" : "warn"}
            >
              {check.name} · {check.state}
            </Pill>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function ReviewImage({ shot }: { shot: ReviewShotView }) {
  const [url, setUrl] = useState<string>(),
    [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void apiReviewImage(shot.id)
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              typeof reader.result === "string"
                ? resolve(reader.result)
                : reject(new Error("The review image could not be read."));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .then((value) => {
        if (active) setUrl(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [shot.id]);
  return (
    <figure>
      <figcaption>
        {shot.label} · {shot.width}px · {shot.theme}
      </figcaption>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={shot.label} loading="lazy" />
        </a>
      ) : (
        <p>{error ? "The review screenshot could not be loaded." : "Loading review screenshot…"}</p>
      )}
    </figure>
  );
}

function Thread({
  pr,
  data,
  flightId,
  disabled,
  now,
}: {
  pr: PullRequestSummary;
  data: PrUatView | undefined;
  flightId: string | null;
  disabled: boolean;
  now: number;
}) {
  const [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  return (
    <Panel title="Related Comms · Ask QA" sub="FLIGHT answers from the review and evidence">
      <div className="pb uat-stack">
        <ol className="uat-thread">
          {[...(data?.comms ?? [])].reverse().map((m) => (
            <li key={m.id} className={m.from === COMMS_CAPCOM ? "uat-you" : "uat-qa"}>
              <header>
                <strong>{m.from === COMMS_CAPCOM ? "You" : m.from}</strong>
                <span>{elapsed(Math.max(0, now - m.at))} ago</span>
              </header>
              <p>{m.text}</p>
            </li>
          ))}
        </ol>
        {!data?.comms.length && <p>No messages for this PR yet.</p>}
        <form
          className="uat-ask"
          onSubmit={async (e) => {
            e.preventDefault();
            if (disabled || busy || pending.current || !question.trim() || !flightId) return;
            pending.current = true;
            setBusy(true);
            setError("");
            try {
              await apiPost("/api/comms", {
                to: flightId,
                label: "question",
                ref: `PR ${pr.number}`,
                repoId: pr.repoId,
                text: `${pr.repoId} ${prLabel(pr.number)}: ${question.trim()}`,
              });
              setQuestion("");
              refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "The question could not be sent.");
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          <label>
            Ask QA about this PR
            <textarea
              value={question}
              maxLength={COMMS_MESSAGE_MAX - 200}
              disabled={disabled || busy || !flightId}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <button type="submit" disabled={disabled || busy || !flightId || !question.trim()}>
            {busy ? "Sending…" : "Ask QA"}
          </button>
        </form>
        {!flightId && <p>No FLIGHT seat is configured to answer questions.</p>}
        {error && (
          <p className="crit-t" role="alert">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}
