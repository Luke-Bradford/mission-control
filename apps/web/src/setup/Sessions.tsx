import {
  type AttentionItem,
  type ConfigView,
  type Crew,
  type CrewChanges,
  type CrewEffort,
  type CrewRow,
  type CrewSessionFolders,
  errorText,
  type ReloadResult,
  type SeatInput,
} from "@mc/core";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
  isUncertain,
  UNCERTAIN_TEXT,
  useSubmitGuard,
} from "../components/formSupport.tsx";
import { modelLine, seatAreaText, seatStatus, useSeatName } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { addAgentPath, agentPath, editSeatPath, navigate } from "../router.ts";
import {
  getSession,
  inSession,
  resetSession,
  setSession,
  useSessionScope,
} from "../shell/session.ts";
import { toast } from "../shell/Toast.tsx";

const DASH = "—";
export const FOLDERS_UNREADABLE = "Could not read the checkout's folders.";
export const FOLDER_FREE = "free";
export const FOLDERS_NOTE =
  "Tiles show who owns each folder; areas can't overlap. A stray change is outside every writer's area: it shows in Needs you, and FLIGHT can work out whose it is.";
export const SESSIONS_NOTE =
  "A session is one repo and the agents working on it, as config.yaml lists them. Add, edit or remove an agent here: Mission Control writes config.yaml, keeps a backup beside it, and applies the change without a restart.";
export const SAVE_NOTE =
  "An agent that is working keeps its current settings until its run ends; a removed one finishes its run first.";
export const AREA_HINT = "click free folder tiles below · none picked = whole checkout";
export const SCRATCH_LABEL = "Reviews PRs in a scratch checkout";
export const NO_STATUS = "—";
export const NO_ROLES = "this server does not list roles";
export const CALL_SIGN_HINT = "lower-case letters, digits and -";
export const refusedText = (error: string) => `Refused: ${error}`;
export const loadErrorText = (error: string) =>
  `config.yaml does not load: ${error}. Mission Control keeps the last good config.`;
export const restartText = (paths: string[]) =>
  `Changed in config.yaml, applies after a hub restart: ${paths.join(", ")}.`;
export const addedText = (call: string, s: string, backup: string) =>
  `${call} added to s/${s}. Backup: ${backup}.`;
export const savedText = (call: string, backup: string) => `${call} saved. Backup: ${backup}.`;
export const removedText = (call: string, s: string, backup: string) =>
  `${call} removed from s/${s}. Backup: ${backup}.`;
export const RELOADED = "Reloaded config.yaml.";

export const CALL_SIGN = /^[a-z][a-z0-9-]{0,30}$/;
const SESSION_FORM_KEY = "add-session";

/** A refused or lost write: what to say, whether the server may still have acted, and where it shows. */
interface SaveFailure {
  text: string;
  uncertain: boolean;
  /** The form (or null: the page) the failure belongs to; a late one never shows in another. */
  formKey: string | null;
  /** Bumps per failure so a repeat of the same text still moves focus to its summary. */
  seq: number;
}
const failureText = (failure: SaveFailure) =>
  failure.uncertain ? `Not confirmed: ${failure.text}` : refusedText(failure.text);
const _seatFormKey = (form: Pick<FormState, "sessionId" | "editId">) =>
  `${form.sessionId}:${form.editId ?? "new"}`;

type SessionView = NonNullable<ConfigView["crew"]>["sessions"][number];
type RoleView = NonNullable<NonNullable<ConfigView["crew"]>["roles"]>[number];

/** The one open add/edit form: `editId` null is an add. `id` null follows the role until typed over. */
interface FormState {
  sessionId: string;
  editId: string | null;
  role: string;
  id: string;
  /** The call sign is still the one derived from the role; typing over it stops that. */
  idAuto: boolean;
  accountId: string;
  model: string;
  effort: CrewEffort | "";
  area: string;
  scratch: boolean;
}

const rolesOf = (config: ConfigView): RoleView[] =>
  [...(config.crew?.roles ?? [])].sort((a, b) => a.name.localeCompare(b.name));

function _seatForm(
  config: ConfigView,
  sessionId: string,
  editing: SeatInput | null = null,
): FormState | null {
  const first = rolesOf(config)[0];
  if (editing === null && !first) return null;
  const account = config.accounts.find((a) => a.id === editing?.accountId) ?? config.accounts[0];
  return {
    sessionId,
    editId: editing?.id ?? null,
    role: editing?.role ?? first?.name ?? "",
    id: first ? freeCallSign(config, editing?.role ?? first.name) : "",
    idAuto: true,
    accountId: editing?.accountId ?? account?.id ?? "",
    model:
      editing?.model ?? (account?.vendor === "codex" ? "gpt-5.6-sol" : (first?.model ?? "sonnet")),
    effort: editing?.effort ?? "",
    area: editing?.area.join(", ") ?? "",
    scratch: editing?.mode === "scratch",
  };
}

/** A save in flight: the whole seat list as it was loaded, the new one, and the toast on success. */
type SaveSeats = (
  session: SessionView,
  base: SeatInput[],
  seats: SeatInput[],
  toastOf: (backup: string) => string,
  formKey?: string | null,
) => void;

/** A row of the seats table: a seat of config.yaml, or one kept only until it is free. */
interface TableSeat {
  id: string;
  role: string;
  model: string;
  area: string[];
  mode?: string;
  input: SeatInput | null;
}

const _globsOf = (text: string): string[] =>
  text
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g !== "");

/** The smallest `{role}-{n}` (n ≥ 1) that no loop and no seat already uses. */
function freeCallSign(config: ConfigView, role: string): string {
  const used = new Set<string>(config.loops.map((l) => l.id));
  for (const s of config.crew?.sessions ?? []) for (const seat of s.seats) used.add(seat.id);
  let n = 1;
  while (used.has(`${role.toLowerCase()}-${n}`)) n++;
  return `${role.toLowerCase()}-${n}`;
}

/** A seat's button: named by its call sign alone; area, model line and state are its description. */
function Seat({ id, area, row }: { id: string; area: string; row: CrewRow | undefined }) {
  const tag = useId();
  const info = useId();
  return (
    <button
      type="button"
      aria-labelledby={tag}
      aria-describedby={info}
      onClick={() => navigate(agentPath(id))}
    >
      <AgentTag domId={tag} id={id} index={row?.index ?? 0} />
      <span id={info} className="seatinfo">
        <span className="xs muted">{area}</span>
        {row && <span className="xs muted">{modelLine(row)}</span>}
        {row && (
          <span title={seatStatus(row).reason ?? seatStatus(row).label}>
            <Pill tone={seatStatus(row).tone}>{seatStatus(row).label}</Pill>
          </span>
        )}
      </span>
    </button>
  );
}

function CrewSession({
  session,
  config,
  crew,
  folders,
  changes,
  busy,
  failure,
  save,
  close,
}: {
  session: SessionView;
  config: ConfigView;
  crew: Crew | undefined;
  folders: CrewSessionFolders | undefined;
  changes: CrewChanges | undefined;
  busy: boolean;
  failure: SaveFailure | null;
  save: SaveSeats;
  close: (opener: HTMLButtonElement) => void;
}) {
  const nameOf = useSeatName();
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const tz = useTz();
  // This session's stray files, from the item's own path (no parsing of its text).
  const strays = (attention ?? []).flatMap((item) =>
    item.kind === "stray" && item.sessionId === session.id && item.path
      ? [{ ...item, path: item.path }]
      : [],
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const repo = config.repos.find((r) => r.id === session.repoId);
  const roles = rolesOf(config);
  const base = changes?.sessions.find((s) => s.id === session.id)?.seats ?? [];
  const tableSeats: TableSeat[] = [
    ...base.map((input) => ({ ...input, input })),
    ...session.seats.filter((s) => s.retiring).map((s) => ({ ...s, input: null })),
  ];

  const areaCell = (s: TableSeat): string => {
    const mode =
      s.mode === "scratch"
        ? "scratch"
        : (roles.find((r) => r.name === s.role)?.mode ??
          session.seats.find((x) => x.id === s.id)?.mode ??
          "writer");
    if (mode === "scratch") return "scratch review";
    if (mode !== "writer") return "read-only";
    return s.area.length > 0 ? s.area.join(", ") : "whole checkout";
  };

  return (
    <Panel
      title={`s/${session.id}`}
      sub={`${session.checkout} · ${repo?.github ?? session.repoId}`}
      actions={
        <>
          <button type="button" disabled={busy} onClick={(e) => close(e.currentTarget)}>
            Close
          </button>
          {changes && (
            <button
              type="button"
              disabled={roles.length === 0 || busy}
              title={roles.length === 0 ? NO_ROLES : undefined}
              onClick={() => navigate(addAgentPath(session.id))}
            >
              Add agent
            </button>
          )}
        </>
      }
    >
      <div className="pb">
        <div className="crew">
          {session.seats.map((seat) => {
            const row = crew?.rows.find((c) => c.id === seat.id);
            return <Seat key={seat.id} id={seat.id} area={seatAreaText(seat)} row={row} />;
          })}
        </div>
        {folders?.readable === false && <p className="muted s">{FOLDERS_UNREADABLE}</p>}
        {folders && folders.folders.length > 0 && (
          <ul className="tiles wrap" aria-label={`Folders of s/${session.id}`}>
            {folders.folders.map((f) => {
              const stray = strays.filter((s) => s.path.startsWith(`${f.name}/`));
              const inner = (
                <>
                  <span className="tile-vis wrap" aria-hidden="true">
                    {f.owners.length > 0 ? (
                      f.owners.map((id, i) => (
                        <Fragment key={id}>
                          {i > 0 && <span className="xs muted"> · </span>}
                          <AgentTag
                            id={id}
                            index={crew?.rows.find((c) => c.id === id)?.index ?? 0}
                            sm
                          />
                        </Fragment>
                      ))
                    ) : (
                      <span className="xs muted">{FOLDER_FREE}</span>
                    )}
                    <span className="s">{`${f.name}/`}</span>
                  </span>
                  {stray.length > 0 && <span className="xs crit-t">Stray change</span>}
                  {stray.map((s) => (
                    <span className="xs warn-t" key={s.key}>
                      {s.path} · {tz ? hhmm(s.at, tz) : DASH}
                    </span>
                  ))}
                  <span className="sr-only">
                    {`${f.name}/: ${f.owners.length > 0 ? f.owners.join(", ") : FOLDER_FREE}`}
                  </span>
                </>
              );
              return (
                <li key={f.name} className={`tile${stray.length > 0 ? " stray" : ""}`}>
                  {inner}
                </li>
              );
            })}
          </ul>
        )}
        <p className="note s">{FOLDERS_NOTE}</p>
        {changes && (
          <div className="tw">
            <table aria-label={`Seats of s/${session.id} in config.yaml`}>
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Role</th>
                  <th>Model</th>
                  <th>Area</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tableSeats.map((s) => {
                  const pending = changes.pending.find(
                    (p) => p.sessionId === session.id && p.seatId === s.id,
                  )?.reason;
                  const input = s.input;
                  const row = crew?.rows.find((c) => c.id === s.id);
                  const status = row ? seatStatus(row) : null;
                  return (
                    <tr key={s.id}>
                      <td>{s.id}</td>
                      <td>{s.role}</td>
                      <td>{s.model}</td>
                      <td>{areaCell(s)}</td>
                      <td>
                        {pending ??
                          (status === null ? (
                            NO_STATUS
                          ) : (
                            <span title={status.reason ?? status.label}>
                              <Pill tone={status.tone}>{status.label}</Pill>
                            </span>
                          ))}
                      </td>
                      <td>
                        {input === null ? null : removing === s.id ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setRemoving(null);
                                save(
                                  session,
                                  base,
                                  base.filter((x) => x.id !== s.id),
                                  (b) => removedText(nameOf(s.id), session.id, b),
                                );
                              }}
                            >
                              {`Confirm remove ${s.id}`}
                            </button>
                            <button type="button" onClick={() => setRemoving(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => navigate(editSeatPath(session.id, s.id))}
                            >
                              Edit
                            </button>
                            <button type="button" disabled={busy} onClick={() => setRemoving(s.id)}>
                              Remove
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {failure !== null && (
          <p role="alert" className="crit-t s">
            {failureText(failure)}
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * Setup › Sessions (catalogue 2.7.1): a panel per repo with its observed loops (none for a repo
 * without any), then one per crew session (`s/{id}`) with its seats, which can be added, edited
 * and removed.
 */
export function Sessions({ config }: { config: ConfigView }) {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const folders = useResource<CrewSessionFolders[]>(RESOURCES.crewSessions).data;
  const changes = useResource<CrewChanges>(RESOURCES.crewChanges).data;
  const { session, inRepo } = useSessionScope(config);
  const [adding, setAdding] = useState(false);
  const addSessionButton = useRef<HTMLButtonElement>(null);
  const sessionFormOpener = useRef<HTMLElement | null>(null);
  const focusReturn = useRef<HTMLElement | null>(null);

  function dismissSessionForm() {
    focusReturn.current = sessionFormOpener.current;
    setAdding(false);
  }
  const [draft, setDraft] = useState({
    repoId: config.repos[0]?.id ?? "",
    source: "",
    branch: "feat/new-work",
    checkoutStrategy: "shared",
    id: "",
  });
  const [created, setCreated] = useState<SessionView[]>([]);
  const [returnedFolders, setReturnedFolders] = useState<CrewSessionFolders[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const allSessions = [
    ...(config.crew?.sessions ?? []),
    ...created.filter((s) => !config.crew?.sessions.some((c) => c.id === s.id)),
  ];
  const currentConfig = {
    ...config,
    crew: config.crew && { ...config.crew, sessions: allSessions },
  };
  const name =
    draft.id.trim() ||
    draft.source
      .trim()
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    "";
  const [busy, setBusy] = useState(false);
  // Restore only after the form unmounts and its opener is enabled again.
  useEffect(() => {
    if (adding || busy || !focusReturn.current) return;
    const opener = focusReturn.current;
    focusReturn.current = null;
    (opener.isConnected ? opener : addSessionButton.current)?.focus();
  });
  // Where a refusal shows: a session's panel, or (null) the page, for a reload.
  const [failure, setFailure] = useState<(SaveFailure & { sessionId: string | null }) | null>(null);
  const failureSeq = useRef(0);
  const guard = useSubmitGuard();
  const [sessionAttempted, setSessionAttempted] = useState(false);
  const [sessionAttempts, setSessionAttempts] = useState(0);
  const field = useId();
  const sessionIds = {
    repoId: `${field}-repo-profile`,
    source: `${field}-repo`,
    branch: `${field}-branch`,
    checkout: `${field}-checkout`,
    name: `${field}-name`,
  };
  const sessionFound: FieldIssue[] = [];
  if (draft.repoId === "")
    sessionFound.push({ id: sessionIds.repoId, message: "Repo profile: choose a repo profile." });
  if (draft.source.trim() === "")
    sessionFound.push({
      id: sessionIds.source,
      message: "Repo: enter the folder of the git checkout.",
    });
  if (draft.branch.trim() === "")
    sessionFound.push({ id: sessionIds.branch, message: "Branch is required." });
  if (
    (draft.id.trim() !== "" || draft.source.trim() !== "") &&
    !/^[a-z][a-z0-9-]{0,30}$/.test(name)
  )
    sessionFound.push({
      id: sessionIds.name,
      message: `Name: ${CALL_SIGN_HINT}, starting with a letter, at most 31 characters.`,
    });
  const sessionIssues = sessionAttempted ? sessionFound : [];
  const crewSessions = allSessions.filter(
    (s) => !closed.includes(s.id) && inSession(session, s.id),
  );

  const refetch = () => {
    hub.refetch(RESOURCES.crewChanges.path);
    hub.refetch(RESOURCES.config.path);
    hub.refetch(RESOURCES.crewSessions.path);
    hub.refetch(RESOURCES.crew.path);
  };

  /** Record a failed write. A lost answer or server fault may still have saved, so reread first. */
  function fail(sessionId: string | null, formKey: string | null, err: unknown) {
    const uncertain = isUncertain(err instanceof ApiError ? err.status : undefined);
    if (uncertain) refetch();
    failureSeq.current += 1;
    setFailure({ sessionId, formKey, text: errorText(err), uncertain, seq: failureSeq.current });
  }

  async function addSession() {
    if (!guard.take()) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await apiPost<{ id: string; folders: string[] }>(ACTIONS.addSession, {
        ...draft,
        id: name,
        source: draft.source.trim(),
        branch: draft.branch.trim(),
      });
      const added: SessionView = {
        id: done.id,
        repoId: draft.repoId,
        checkout:
          draft.checkoutStrategy === "separate" ? "Checkout details loading…" : draft.source.trim(),
        seats: [],
      };
      setClosed((s) => s.filter((id) => id !== done.id));
      setCreated((s) => [...s.filter((session) => session.id !== done.id), added]);
      setReturnedFolders((s) => [
        ...s,
        {
          id: done.id,
          readable: true,
          folders: done.folders.map((name) => ({ name, owners: [] })),
        },
      ]);
      setSession(done.id);
      dismissSessionForm();
      toast(
        `s/${done.id} added${draft.checkoutStrategy === "separate" ? " with its own checkout" : ""}. Now add its first agent.`,
      );
      refetch();
    } catch (err) {
      fail(null, SESSION_FORM_KEY, err);
      toast(errorText(err));
    } finally {
      guard.release();
      setBusy(false);
    }
  }

  async function closeSession(id: string, opener: HTMLButtonElement) {
    if (!guard.take()) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await apiPost<{
        id: string;
        checkout: string;
        retainedPath: string | null;
        outcome?: string;
      }>(ACTIONS.closeSession(id), {});
      const reason =
        done.checkout === "retained-dirty"
          ? "The branch has uncommitted changes."
          : done.checkout === "retained-unpushed"
            ? "The branch has unpushed commits."
            : (done.outcome ?? "Safe removal could not be proved.");
      toast(
        `s/${done.id} closed${done.checkout === "removed" ? "; its separate checkout is removed." : done.checkout === "unmanaged" ? `; repo folder retained: ${done.retainedPath}.` : `; checkout retained: ${done.retainedPath}. ${reason}`}`,
      );
      focusReturn.current = opener;
      setClosed((s) => [...s, done.id]);
      if (getSession() === done.id) resetSession();
      refetch();
    } catch (err) {
      toast(errorText(err));
    } finally {
      guard.release();
      setBusy(false);
    }
  }

  const save: SaveSeats = async (s, base, seats, toastOf, formKey = null) => {
    if (!guard.take()) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await apiPost<{ backup: string; changes: ReloadResult }>(
        ACTIONS.crewSeats(s.id),
        { base, seats },
      );
      toast(toastOf(done.backup));
      refetch();
    } catch (err) {
      fail(s.id, formKey, err);
      // Another tab saved first: the next try needs the fresh base.
      if (err instanceof ApiError && err.status === 409) refetch();
    } finally {
      guard.release();
      setBusy(false);
    }
  };

  async function reload() {
    if (!guard.take()) return;
    setBusy(true);
    setFailure(null);
    try {
      await apiPost<ReloadResult>(ACTIONS.reloadConfig, {});
      toast(RELOADED);
      refetch();
    } catch (err) {
      fail(null, null, err);
    } finally {
      guard.release();
      setBusy(false);
    }
  }

  return (
    <>
      <p className="note wide">{SESSIONS_NOTE}</p>
      <div className="wide">
        {!adding ? (
          <button
            type="button"
            className="primary"
            ref={addSessionButton}
            disabled={busy || config.repos.length === 0}
            onClick={(e) => {
              sessionFormOpener.current = e.currentTarget;
              setAdding(true);
              setSessionAttempted(false);
              setFailure(null);
            }}
          >
            Add session
          </button>
        ) : (
          <form
            className="seatform sessionform fform fform-640"
            aria-label="Add session"
            noValidate
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) dismissSessionForm();
            }}
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              setSessionAttempted(true);
              if (sessionFound.length > 0) {
                setSessionAttempts((n) => n + 1);
                return;
              }
              void addSession();
            }}
          >
            <fieldset disabled={busy} className="fcontent">
              <fieldset className="fgroup">
                <legend>Identity and source</legend>
                <div className="fpair">
                  <div className="ffield">
                    <label htmlFor={sessionIds.repoId}>Repo profile</label>
                    <select
                      {...fieldProps(sessionIds.repoId, issueOf(sessionIssues, sessionIds.repoId))}
                      value={draft.repoId}
                      onChange={(e) => setDraft({ ...draft, repoId: e.target.value })}
                    >
                      {config.repos.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id}
                        </option>
                      ))}
                    </select>
                    <FieldError
                      id={sessionIds.repoId}
                      error={issueOf(sessionIssues, sessionIds.repoId)}
                    />
                  </div>
                  <div className="ffield">
                    <label htmlFor={sessionIds.name}>Name</label>
                    <input
                      {...fieldProps(
                        sessionIds.name,
                        issueOf(sessionIssues, sessionIds.name),
                        `${sessionIds.name}-hint`,
                      )}
                      value={draft.id}
                      placeholder={name}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    />
                    <FieldError
                      id={sessionIds.name}
                      error={issueOf(sessionIssues, sessionIds.name)}
                    />
                  </div>
                </div>
                <p id={`${sessionIds.name}-hint`} className="fhint muted xs">
                  Name: leave empty to use the repo folder's name.
                </p>
                <div className="ffield">
                  <label htmlFor={sessionIds.source}>Repo</label>
                  <input
                    {...fieldProps(sessionIds.source, issueOf(sessionIssues, sessionIds.source))}
                    value={draft.source}
                    onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                  />
                  <FieldError
                    id={sessionIds.source}
                    error={issueOf(sessionIssues, sessionIds.source)}
                  />
                </div>
                <div className="ffield">
                  <label htmlFor={sessionIds.branch}>Branch</label>
                  <input
                    {...fieldProps(sessionIds.branch, issueOf(sessionIssues, sessionIds.branch))}
                    value={draft.branch}
                    onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
                  />
                  <FieldError
                    id={sessionIds.branch}
                    error={issueOf(sessionIssues, sessionIds.branch)}
                  />
                </div>
              </fieldset>
              <fieldset className="fgroup">
                <legend>Checkout and scope</legend>
                <div className="ffield">
                  <label htmlFor={sessionIds.checkout}>Checkout</label>
                  <select
                    id={sessionIds.checkout}
                    value={draft.checkoutStrategy}
                    onChange={(e) => setDraft({ ...draft, checkoutStrategy: e.target.value })}
                  >
                    <option value="shared">use the repo folder (nothing else on it)</option>
                    <option value="separate">make a separate checkout for this branch</option>
                  </select>
                </div>
                <p className="feffect s" data-testid="session-effect">
                  {`Adds s/${name || "…"} on repo profile ${draft.repoId || "…"}: branch ${draft.branch.trim() || "…"} of ${draft.source.trim() || "the repo folder"}, ${
                    draft.checkoutStrategy === "separate"
                      ? "in a separate checkout made for it."
                      : "which uses the repo folder as it is."
                  }`}
                </p>
              </fieldset>
              <ErrorSummary
                title={
                  sessionIssues.length > 0
                    ? "Fix before saving"
                    : failure?.uncertain
                      ? "Result unknown"
                      : "Not saved"
                }
                issues={sessionIssues}
                message={
                  failure?.formKey === SESSION_FORM_KEY && sessionIssues.length === 0
                    ? failureText(failure)
                    : null
                }
                focusKey={
                  sessionAttempts + (failure?.formKey === SESSION_FORM_KEY ? failure.seq : 0)
                }
              >
                {failure?.formKey === SESSION_FORM_KEY && failure.uncertain && (
                  <p className="s">{UNCERTAIN_TEXT}</p>
                )}
              </ErrorSummary>
              {busy && (
                <p role="status" className="fstatus s">
                  {`Adding session s/${name}…`}
                </p>
              )}
              <div className="fact">
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? "Adding session…" : "Add session"}
                </button>
                <button type="button" disabled={busy} onClick={dismissSessionForm}>
                  Cancel
                </button>
              </div>
            </fieldset>
            <p className="note s">
              Mission Control checks it's a git checkout on that branch and lists its top folders
              for areas. The repo profile adds that repo's guard rules, test commands and which of
              them count as a full suite.
            </p>
          </form>
        )}
        {config.repos.length === 0 && <p className="note s">Add a repo in Setup first.</p>}
      </div>
      {failure?.sessionId === null && failure.formKey !== SESSION_FORM_KEY && (
        <p role="alert" className="crit-t s">
          {failureText(failure)}
        </p>
      )}
      <div className="wide">
        <button type="button" disabled={busy} onClick={() => void reload()}>
          Reload config.yaml
        </button>
      </div>
      {config.repos
        .filter((r) => inRepo(r.id))
        .filter((r) => config.loops.some((l) => l.repoId === r.id))
        .map((r) => {
          const first = config.loops.find((l) => l.repoId === r.id);
          const branch = crew?.rows.find((c) => c.id === first?.id)?.run?.branch ?? DASH;
          const rows = crew?.rows.filter((c) => c.kind === "loop" && c.repoId === r.id) ?? [];
          return (
            <Panel key={r.id} title={`${r.id} · observed loops`} sub={`${r.github} · ${branch}`}>
              <div className="pb">
                {/* Nothing is known until the crew loads (or while it fails to). */}
                {crew === undefined ? null : rows.length === 0 ? (
                  <p className="muted s">No agents yet.</p>
                ) : (
                  <div className="crew">
                    {rows.map((c) => (
                      <button key={c.id} type="button" onClick={() => navigate(agentPath(c.id))}>
                        <AgentTag id={c.id} index={c.index} />
                        <span className="xs muted">observed loop</span>
                        <span title={seatStatus(c).reason ?? seatStatus(c).label}>
                          <Pill tone={seatStatus(c).tone}>{seatStatus(c).label}</Pill>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          );
        })}
      {crewSessions.length > 0 && <CrewOff className="note wide" />}
      {crewSessions.map((s) => (
        <CrewSession
          key={s.id}
          session={s}
          config={currentConfig}
          crew={crew}
          folders={
            folders?.find((f) => f.id === s.id) ?? returnedFolders.find((f) => f.id === s.id)
          }
          changes={changes}
          busy={busy}
          failure={failure?.sessionId === s.id ? failure : null}
          save={save}
          close={(opener) => void closeSession(s.id, opener)}
        />
      ))}
    </>
  );
}
