import {
  CMUX_SESSION_STATE_LABEL,
  type CmuxSessionRow,
  type CmuxSessionState,
  type CmuxSessionsView,
  type OpenSessionInput,
  type PillTone,
  SESSION_CHECK_SOURCE_LABEL,
  SESSION_CHECK_STATE_LABEL,
  SESSION_NO_CHECKS_TEXT,
  SESSION_TEXT_MAX,
  SESSIONS_REFRESH_MS,
  type SessionCheck,
  type SessionCheckState,
  type SessionRepoChecks,
  type SpendCell,
  sortSessions,
} from "@mc/core";
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { clockTime, cost, kTokens, plural } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import "../hud/charts/Hover.css";
import { toast } from "../shell/Toast.tsx";
import "./sessions.css";

// The rows come from GET /api/sessions, which the hub reads from cmux itself, with no agent.

const STATE_TONE: Record<CmuxSessionState, PillTone> = {
  waiting: "warn",
  working: "ok",
  idle: "neutral",
  "no-agent": "plain",
};

const CHECK_TONE: Record<SessionCheckState, PillTone> = {
  passed: "ok",
  failed: "crit",
  "timed-out": "warn",
  running: "neutral",
  queued: "neutral",
  stopped: "plain",
};

const COLUMNS = 10;

/** Time in a state as this hub saw it: `4m`, `3h`, `2d`. */
export function forLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** A home folder reads as `~`; the full path stays in the cell's title. */
const shortFolder = (folder: string): string => folder.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

/** The address without its scheme: `localhost:5173`. */
const shortUrl = (url: string): string => url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");

type Spend = NonNullable<CmuxSessionRow["spend"]>;

/**
 * One window's ~cost: `—` with no use, `no price` when every token's model has none, and `~$1.23+`
 * when some have none, so an unknown cost never reads as a known one.
 */
function spendAmount(c: SpendCell, unpriced: number): string {
  if (c.tokens === 0) return "—";
  if (unpriced >= c.tokens) return "no price";
  return `${cost(c.costUsd)}${unpriced > 0 ? "+" : ""}`;
}

function spendWindow(label: string, c: SpendCell, unpriced: number): string {
  const without =
    unpriced === 0
      ? ""
      : unpriced >= c.tokens
        ? ", all without a price"
        : `, ${kTokens(unpriced)} without a price`;
  return `${label} ${spendAmount(c, unpriced)} · ${kTokens(c.tokens)} tok${without}`;
}

/** The Today cell's hover and focus text: today's and the last 7 local days' ~cost and tokens. */
export const spendTitle = (s: Spend): string =>
  `${spendWindow("Today", s.today, s.unpricedTokens.today)} · ${spendWindow("Last 7 days", s.week, s.unpricedTokens.week)}`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "The hub did not answer.";

/**
 * Sessions: "What is each of my cmux sessions doing, and which one needs me?" Every cmux workspace
 * on this Mac, read from cmux by the hub with no agent, every few seconds while the page is open.
 */
export function Sessions() {
  const res = useResource<CmuxSessionsView>(RESOURCES.sessions);
  const tz = useTz();
  useEffect(() => {
    const timer = setInterval(() => hub.refetch(RESOURCES.sessions.path), SESSIONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const view = res.data;
  const [good, setGood] = useState<Extract<CmuxSessionsView, { ok: true }>>();
  useEffect(() => {
    if (view?.ok) setGood(view);
  }, [view]);
  const shown = view?.ok ? view : good;
  const rows = useMemo(() => (shown ? sortSessions(shown.sessions) : []), [shown]);
  const repos = shown?.repos ?? [];
  const error = view && !view.ok ? view.error : res.error ? res.error.message : null;
  const time = (at: number) => (tz ? clockTime(at, tz) : "—");
  const [opening, setOpening] = useState(false);

  return (
    <section id="page-sessions" className="panel sess" aria-labelledby="sess-title">
      <div className="ph sess-head">
        <h1 id="sess-title">Sessions</h1>
        {shown && <Summary rows={rows} />}
        <span className="sess-read">
          {shown
            ? `${error ? "Last good read" : "Read from cmux"} ${time(shown.at)} · every ${SESSIONS_REFRESH_MS / 1000} s`
            : null}
        </span>
        <button
          type="button"
          className="sess-new"
          aria-expanded={opening}
          aria-controls={opening ? "sess-open" : undefined}
          onClick={() => setOpening(!opening)}
        >
          New session
        </button>
      </div>
      {opening && <OpenForm onClose={() => setOpening(false)} />}
      {error && (
        <p className="sess-banner" role="alert">
          Could not read cmux: {error}
        </p>
      )}
      {!shown ? (
        error ? null : (
          <p className="sess-note">Reading cmux…</p>
        )
      ) : rows.length === 0 ? (
        <p className="sess-note">No cmux workspaces are open.</p>
      ) : (
        <div className="sess-scroll">
          <SessionTable rows={rows} repos={repos} now={shown.at} time={time} />
        </div>
      )}
      {repos.length > 0 && <RepoChecks repos={repos} />}
      <p className="sess-foot">
        Click a row or press Enter to open it in cmux. The hub never closes a session.
      </p>
    </section>
  );
}

function Summary({ rows }: { rows: readonly CmuxSessionRow[] }) {
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const working = rows.filter((r) => r.state === "working").length;
  return (
    <span className="sess-summary">
      <b>{plural(rows.length, "session")}</b> ·{" "}
      <b className={waiting > 0 ? "sess-w" : undefined}>{waiting}</b> waiting on you ·{" "}
      <b>{working}</b> working
    </span>
  );
}

function SessionTable({
  rows,
  repos,
  now,
  time,
}: {
  rows: readonly CmuxSessionRow[];
  repos: readonly SessionRepoChecks[];
  now: number;
  time: (at: number) => string;
}) {
  const named = new Set(repos.filter((r) => r.commands.length > 0).map((r) => r.repo));
  const [writing, setWriting] = useState<string | null>(null);
  // Which rows show their newest inbox message; by id, so a refresh keeps it open.
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const toggleRead = (id: string) =>
    setReading((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <table className="sess-table">
      <colgroup>
        <col className="c-name" />
        <col className="c-folder" />
        <col className="c-state" />
        <col className="c-for" />
        <col className="c-today" />
        <col />
        <col className="c-status" />
        <col className="c-app" />
        <col className="c-check" />
        <col className="c-act" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Session</th>
          <th scope="col">Folder · repo</th>
          <th scope="col" aria-sort="ascending">
            State <span aria-hidden="true">↓</span>
          </th>
          <th scope="col" className="num">
            For
          </th>
          <th
            scope="col"
            className="num"
            title="Priced from each transcript's token counts at API list rates. Local midnight to now."
          >
            Today
          </th>
          <th scope="col">Last line</th>
          <th scope="col">Status</th>
          <th scope="col">App</th>
          <th scope="col">Checks</th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <SessionRow
            key={r.id}
            row={r}
            now={now}
            time={time}
            hasChecks={r.repoKey !== null && named.has(r.repoKey)}
            writing={writing === r.id}
            onWrite={(on) => setWriting(on ? r.id : null)}
            reading={reading.has(r.id)}
            onRead={() => toggleRead(r.id)}
          />
        ))}
      </tbody>
    </table>
  );
}

async function post(path: string, body: unknown = {}): Promise<boolean> {
  try {
    await apiPost(path, body);
    return true;
  } catch (error) {
    toast(message(error));
    return false;
  }
}

function SessionRow({
  row: r,
  now,
  time,
  hasChecks,
  writing,
  onWrite,
  reading,
  onRead,
}: {
  row: CmuxSessionRow;
  now: number;
  time: (at: number) => string;
  hasChecks: boolean;
  writing: boolean;
  onWrite: (on: boolean) => void;
  reading: boolean;
  onRead: () => void;
}) {
  const msgId = `sess-msg-${r.id}`;
  const newest = r.inbox.unread > 0 ? r.inbox.newest : null;
  const open = () => void post(ACTIONS.sessionFocus(r.id));
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" && e.target === e.currentTarget) open();
  };
  return (
    <>
      <tr
        className={`sess-row ${r.state}`}
        tabIndex={0}
        title="Open in cmux"
        onClick={open}
        onKeyDown={onKey}
      >
        <td>
          <div className="sess-who">
            <span className="sess-name" title={r.name}>
              {r.name}
            </span>
            <span className="sess-tags">
              <span className={`sess-tag ${r.owner}`}>{r.owner === "crew" ? "Crew" : "Yours"}</span>
              {r.inbox.unread > 0 &&
                (newest ? (
                  <button
                    type="button"
                    className="sess-inbox"
                    aria-label={`${r.inbox.unread} unread ${r.inbox.unread === 1 ? "message" : "messages"} for ${r.name}`}
                    aria-expanded={reading}
                    aria-controls={reading ? msgId : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRead();
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    onMouseDown={keepRowStill}
                  >
                    {r.inbox.unread} unread
                  </button>
                ) : (
                  <span className="sess-inbox">{r.inbox.unread} unread</span>
                ))}
            </span>
          </div>
        </td>
        <td className="sess-folder" title={r.folder ?? undefined}>
          {r.folder ? shortFolder(r.folder) : "—"}
          {r.repo && (
            <>
              {" · "}
              <b>{r.repo}</b>
            </>
          )}
        </td>
        <td>
          <Pill tone={STATE_TONE[r.state]}>{CMUX_SESSION_STATE_LABEL[r.state]}</Pill>
        </td>
        <td className="num" title={`In this state since this hub first saw it`}>
          {forLabel(now - r.since)}
        </td>
        <td className="num">
          {r.spend && (r.spend.today.tokens > 0 || r.spend.week.tokens > 0) ? (
            <SpendToday spend={r.spend} />
          ) : (
            <Dash />
          )}
        </td>
        <td className="sess-last" title={r.lastLine ?? undefined}>
          {r.lastLine ?? <span className="sess-dash">—</span>}
        </td>
        <td className="sess-status" title={r.status ?? undefined}>
          {r.status ?? <span className="sess-dash">—</span>}
        </td>
        <td className="sess-app">{r.app ? <AppCell id={r.id} app={r.app} /> : <Dash />}</td>
        <td className="sess-check">
          {r.check ? <CheckCell check={r.check} time={time} /> : <Dash />}
        </td>
        <td className="sess-acts">
          <button
            type="button"
            className="sess-write"
            aria-label={`Write to ${r.name}`}
            aria-expanded={writing}
            onClick={(e) => {
              e.stopPropagation();
              onWrite(!writing);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            onMouseDown={keepRowStill}
          >
            Write
          </button>
          {r.owner === "operator" && (
            <button
              type="button"
              className="sess-run"
              aria-label={`Run checks for ${r.name}`}
              title={hasChecks ? "Run this repo's checks now" : SESSION_NO_CHECKS_TEXT}
              disabled={!hasChecks}
              onClick={(e) => {
                e.stopPropagation();
                void post(ACTIONS.sessionChecks(r.id)).then(
                  (ok) => ok && toast(`Checks queued for ${r.name}.`),
                );
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              Run<span className="sess-run-more"> checks</span>
            </button>
          )}
        </td>
      </tr>
      {reading && newest && (
        <tr className="sess-msg">
          <td colSpan={COLUMNS} id={msgId}>
            <span className="sess-msg-label">Newest message</span> {newest}
          </td>
        </tr>
      )}
      {writing && <Composer row={r} onClose={() => onWrite(false)} />}
    </>
  );
}

/**
 * A row's button takes no focus from the mouse: a focused row wraps its last line and grows, which
 * would move the button between press and release and turn the click into a click on the row.
 */
const keepRowStill = (e: MouseEvent) => e.preventDefault();

/**
 * Today's ~cost; hover or keyboard focus shows today and the last 7 days on screen. The tip sits on
 * the page, outside the table, so the cell's clipping never cuts it.
 */
function SpendToday({ spend }: { spend: Spend }) {
  const [at, setAt] = useState<{ right: number; top: number } | null>(null);
  const tip = useId();
  const show = (target: HTMLElement) => {
    const box = target.getBoundingClientRect();
    // right-aligned under the figure, as the column is; kept inside the window
    setAt({
      right: Math.max(8, window.innerWidth - box.right),
      top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - 48)),
    });
  };
  const text = spendAmount(spend.today, spend.unpricedTokens.today);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus and hover disclose the week, not an action
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the week, as hover does
      tabIndex={0}
      aria-describedby={at ? tip : undefined}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setAt(null)}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAt(null)}
    >
      {text === "no price" ? "No price" : text}
      {at &&
        createPortal(
          <span
            id={tip}
            role="tooltip"
            className="tip"
            style={{ position: "fixed", zIndex: 20, right: at.right, top: at.top }}
          >
            {spendTitle(spend)}
          </span>,
          document.body,
        )}
    </span>
  );
}

const Dash = () => <span className="sess-dash">—</span>;

function CheckCell({ check, time }: { check: SessionCheck; time: (at: number) => string }) {
  const title = [check.command, time(check.at)].filter((t) => t !== null && t !== "—").join(" · ");
  // The detail shows, in full, while the row has keyboard focus; a pointer reads the title.
  return (
    <span title={title || undefined}>
      <Pill tone={CHECK_TONE[check.state]}>{SESSION_CHECK_STATE_LABEL[check.state]}</Pill>
      {title && <span className="sess-check-detail">{title}</span>}
    </span>
  );
}

/** One line per repo a session of the operator's is in: its switch, its checks and where they come from. */
function RepoChecks({ repos }: { repos: readonly SessionRepoChecks[] }) {
  return (
    <section className="sess-repos" aria-labelledby="sess-repos-title">
      <h2 id="sess-repos-title">Repo checks</h2>
      <ul>
        {repos.map((r) => (
          <RepoLine key={r.repo} repo={r} />
        ))}
      </ul>
      <p className="sess-hint">
        Checks run one at a time, at low priority, and stop after 15 minutes. A failure goes to the
        session and to you.
      </p>
    </section>
  );
}

function RepoLine({ repo: r }: { repo: SessionRepoChecks }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = r.source === "page" || r.source === null;
  const commands = r.commands.join(" · ");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const list = text
      .split("\n")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    try {
      await apiPost(ACTIONS.sessionRepoChecks, { repo: r.repo, commands: list });
      setEditing(false);
      hub.refetch(RESOURCES.sessions.path);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="sess-repo">
      <label className="sess-repo-on">
        <input
          type="checkbox"
          checked={r.on}
          aria-label={`Run checks when a session finishes in ${r.name}`}
          onChange={(e) =>
            void post(ACTIONS.sessionRepoChecks, { repo: r.repo, on: e.target.checked }).then(() =>
              hub.refetch(RESOURCES.sessions.path),
            )
          }
        />
        Run checks when a session finishes
      </label>
      <b className="sess-repo-name" title={r.repo}>
        {r.name}
      </b>
      <code className="sess-repo-cmds" title={commands || undefined}>
        {commands || "—"}
      </code>
      <span className="sess-repo-src">{SESSION_CHECK_SOURCE_LABEL[r.source ?? "none"]}</span>
      {editable && !editing && (
        <button
          type="button"
          className="ghost"
          aria-label={`Edit checks for ${r.name}`}
          onClick={() => {
            setText(r.pageCommands.join("\n"));
            setError(null);
            setEditing(true);
          }}
        >
          Edit
        </button>
      )}
      {editing && (
        <form className="sess-repo-edit" onSubmit={(e) => void save(e)}>
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the operator just asked to edit here
            autoFocus
            rows={3}
            aria-label={`Checks for ${r.name}, one command a line`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {error && <p className="sess-err">{error}</p>}
        </form>
      )}
    </li>
  );
}

function AppCell({ id, app }: { id: string; app: NonNullable<CmuxSessionRow["app"]> }) {
  const [word, tone] =
    app.answers === true
      ? ["Answers", "ok"]
      : app.answers === false
        ? ["Not answering", "crit"]
        : ["Not checked", "muted"];
  return (
    <div className="sess-appcell">
      <button
        type="button"
        className="sess-applink"
        title={`Open ${app.url} in this session's cmux browser`}
        aria-label={`Open ${shortUrl(app.url)} in this session's cmux browser`}
        onClick={(e) => {
          e.stopPropagation();
          void post(ACTIONS.sessionApp(id));
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onMouseDown={keepRowStill}
      >
        {shortUrl(app.url)}
      </button>
      <span className={`sess-ans ${tone}`}>{word}</span>
    </div>
  );
}

function Composer({ row, onClose }: { row: CmuxSessionRow; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.sessionSend(row.id), { text });
      toast(`Sent to ${row.name}.`);
      onClose();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <tr className="sess-composer">
      <td colSpan={COLUMNS}>
        <form className="sess-compose" onSubmit={(e) => void submit(e)}>
          <input
            // biome-ignore lint/a11y/noAutofocus: the operator just asked to write here
            autoFocus
            aria-label={`Write to ${row.name}`}
            value={text}
            maxLength={SESSION_TEXT_MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <button type="submit" className="primary" disabled={busy || text.trim() === ""}>
            Send
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </form>
        {error ? (
          <p className="sess-err">{error}</p>
        ) : (
          <p className="sess-hint">
            Pasted into the session, then Enter. Logged as written by you.
          </p>
        )}
      </td>
    </tr>
  );
}

/** The New session form's choices, from GET /api/sessions/roles. */
interface OpenChoices {
  roles: string[];
  folders: string[];
}

/**
 * Opens a new Claude session in cmux for the operator: a folder (or a fresh worktree of its repo),
 * a role from roles/ and a first message. The session is the operator's, not the crew's.
 */
function OpenForm({ onClose }: { onClose: () => void }) {
  const choices = useResource<OpenChoices>(RESOURCES.sessionRoles);
  const [folder, setFolder] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [role, setRole] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = folder.trim() !== "" && role !== "" && text.trim() !== "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const body: OpenSessionInput = { folder: folder.trim(), worktree, role, message: text };
    try {
      const opened = await apiPost<{ id: string; name: string }>(ACTIONS.sessionOpen, body);
      toast(`Opened ${opened.name}.`);
      hub.refetch(RESOURCES.sessions.path);
      onClose();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  const roles = choices.data?.roles ?? [];
  return (
    <form
      id="sess-open"
      className="sess-open"
      aria-label="New session"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <label className="sess-field sess-folderin">
        <span>Folder</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: the operator just asked for a new session
          autoFocus
          value={folder}
          list="sess-folders"
          placeholder="/Users/you/Dev/repo"
          onChange={(e) => setFolder(e.target.value)}
        />
        <datalist id="sess-folders">
          {(choices.data?.folders ?? []).map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <label className="sess-check">
        <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
        Fresh worktree
      </label>
      <label className="sess-field">
        <span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">
            {choices.data ? "Choose a role" : choices.error ? "Roles not read" : "Reading roles…"}
          </option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="sess-field sess-first">
        <span>First message</span>
        <textarea
          rows={3}
          value={text}
          maxLength={SESSION_TEXT_MAX}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="sess-open-act">
        <button type="submit" className="primary" disabled={busy || !ready}>
          {busy ? "Opening…" : "Open"}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className="sess-err" role="alert">
          {error}
        </p>
      ) : choices.error ? (
        <p className="sess-err">Could not read the roles: {choices.error.message}</p>
      ) : (
        <p className="sess-hint">
          Opens Claude in a new cmux workspace with the role's prompt, then sends the message. The
          session is yours.
        </p>
      )}
    </form>
  );
}
