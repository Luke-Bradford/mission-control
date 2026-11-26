import {
  CMUX_SESSION_STATE_LABEL,
  type CmuxSessionRow,
  type CmuxSessionState,
  type CmuxSessionsView,
  type OpenSessionInput,
  type PillTone,
  SESSION_TEXT_MAX,
  SESSIONS_REFRESH_MS,
  sortSessions,
} from "@mc/core";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { clockTime, plural } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { toast } from "../shell/Toast.tsx";
import "./sessions.css";

// The rows come from GET /api/sessions, which the hub reads from cmux itself, with no agent.

const STATE_TONE: Record<CmuxSessionState, PillTone> = {
  waiting: "warn",
  working: "ok",
  idle: "neutral",
  "no-agent": "plain",
};

const COLUMNS = 8;

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
          <SessionTable rows={rows} now={shown.at} />
        </div>
      )}
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

function SessionTable({ rows, now }: { rows: readonly CmuxSessionRow[]; now: number }) {
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
        <col />
        <col className="c-status" />
        <col className="c-app" />
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
          <th scope="col">Last line</th>
          <th scope="col">Status</th>
          <th scope="col">App</th>
          <th scope="col">
            <span className="sr-only">Write</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <SessionRow
            key={r.id}
            row={r}
            now={now}
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
  writing,
  onWrite,
  reading,
  onRead,
}: {
  row: CmuxSessionRow;
  now: number;
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
        <td className="sess-last" title={r.lastLine ?? undefined}>
          {r.lastLine ?? <span className="sess-dash">—</span>}
        </td>
        <td className="sess-status" title={r.status ?? undefined}>
          {r.status ?? <span className="sess-dash">—</span>}
        </td>
        <td className="sess-app">{r.app ? <AppCell id={r.id} app={r.app} /> : <Dash />}</td>
        <td>
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
          >
            Write
          </button>
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

const Dash = () => <span className="sess-dash">—</span>;

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
