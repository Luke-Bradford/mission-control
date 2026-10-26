import {
  type AttentionItem,
  type CliAccountStatus,
  type ConfigView,
  CREW_EFFORTS,
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
import { modelLine, seatAreaText, seatStatus } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { addAgentParam, agentPath, navigate, withoutAddAgentParam } from "../router.ts";
import { useSeatName } from "../seatName.ts";
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

const CALL_SIGN = /^[a-z][a-z0-9-]{0,30}$/;

type SessionView = NonNullable<ConfigView["crew"]>["sessions"][number];
type RoleView = NonNullable<NonNullable<ConfigView["crew"]>["roles"]>[number];

/** The one open add/edit form: `editId` null is an add. `id` null follows the role until typed over. */
interface FormState {
  sessionId: string;
  editId: string | null;
  role: string;
  id: string | null;
  accountId: string;
  model: string;
  effort: CrewEffort | "";
  area: string;
  scratch: boolean;
}

const rolesOf = (config: ConfigView): RoleView[] =>
  [...(config.crew?.roles ?? [])].sort((a, b) => a.name.localeCompare(b.name));

function seatForm(
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
    id: null,
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

const globsOf = (text: string): string[] =>
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

/** The add and edit form of one seat: the fields of a SeatInput, and nothing the server decides. */
function SeatForm({
  session,
  config,
  roles,
  form,
  setForm,
  busy,
  error,
  onSave,
}: {
  session: SessionView;
  config: ConfigView;
  roles: RoleView[];
  form: FormState;
  setForm: (f: FormState | null) => void;
  busy: boolean;
  error: string | null;
  onSave: (seat: SeatInput) => void;
}) {
  const adding = form.editId === null;
  const role = roles.find((r) => r.name === form.role);
  const writer = role?.mode === "writer";
  const accounts = config.accounts;
  const vendor = accounts.find((a) => a.id === form.accountId)?.vendor;
  const statuses = useResource<CliAccountStatus[]>(RESOURCES.accountStatus);
  const status = statuses.data?.find((a) => a.accountId === form.accountId);
  const unavailable = session.seats.find((s) => s.id === form.editId)?.unavailable;
  const cliHint = unavailable || statuses.error || (status && status.status !== "logged-in");
  const id = form.editId ?? form.id ?? freeCallSign(config, form.role);
  const idOk = !adding || CALL_SIGN.test(id);
  const valid = idOk && form.model.trim() !== "" && form.accountId !== "";
  const patch = (p: Partial<FormState>) => setForm({ ...form, ...p });

  function onRole(name: string) {
    const next = roles.find((r) => r.name === name);
    patch({
      role: name,
      model: vendor === "codex" ? "gpt-5.6-sol" : (next?.model ?? form.model),
      scratch: false,
      area: next?.mode === "writer" ? form.area : "",
    });
  }

  function save() {
    const seat: SeatInput = {
      id,
      role: form.role,
      accountId: form.accountId,
      model: form.model.trim(),
      area: writer ? globsOf(form.area) : [],
    };
    if (form.effort !== "") seat.effort = form.effort;
    if (form.scratch) seat.mode = "scratch";
    onSave(seat);
  }

  return (
    <form
      className="seatform"
      aria-label={adding ? `Add agent to s/${session.id}` : `Edit ${id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) save();
      }}
    >
      <div className="frow">
        <label className="s fg2">
          Role
          <select value={form.role} onChange={(e) => onRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {`${r.name} · ${r.mode}`}
              </option>
            ))}
          </select>
        </label>
        {adding ? (
          <label className="s fg2">
            Call sign
            <input value={id} onChange={(e) => patch({ id: e.target.value })} />
            {!idOk && <span className="crit-t xs">{CALL_SIGN_HINT}</span>}
          </label>
        ) : (
          <div className="s fg2">
            Call sign
            <div>{id}</div>
          </div>
        )}
        <label className="s fg2">
          Account
          <select
            value={form.accountId}
            onChange={(e) => {
              const accountId = e.target.value;
              const nextVendor = accounts.find((a) => a.id === accountId)?.vendor;
              patch({
                accountId,
                ...(nextVendor !== vendor
                  ? {
                      model:
                        nextVendor === "codex"
                          ? "gpt-5.6-sol"
                          : role?.model && !role.model.startsWith("gpt-")
                            ? role.model
                            : "sonnet",
                      effort: "",
                    }
                  : {}),
              });
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
        </label>
        <label className="s fg2">
          Model
          <input value={form.model} onChange={(e) => patch({ model: e.target.value })} />
        </label>
        <label className="s fg2">
          Effort
          <select
            value={form.effort}
            onChange={(e) => patch({ effort: e.target.value as CrewEffort | "" })}
          >
            <option value="">CLI default</option>
            {CREW_EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="s fg2">
          Area
          <input
            value={form.area}
            disabled={!writer}
            onChange={(e) => patch({ area: e.target.value })}
          />
          <span className="xs muted">{AREA_HINT}</span>
        </label>
      </div>
      {role?.mode === "read-only" && role.loop === "none" && (
        <label className="s">
          <input
            type="checkbox"
            checked={form.scratch}
            onChange={(e) => patch({ scratch: e.target.checked })}
          />{" "}
          {SCRATCH_LABEL}
        </label>
      )}
      <div className="frow">
        <button type="submit" className="primary" disabled={!valid || busy}>
          {adding ? "Add agent" : `Save ${id}`}
        </button>
        <button type="button" onClick={() => setForm(null)}>
          Cancel
        </button>
      </div>
      {cliHint && (
        <p className="note s">
          Sign in with the CLI on this machine. Mission Control reads this machine's CLI login,
          identity and plan.
        </p>
      )}
      <p className="note s">{SAVE_NOTE}</p>
      {error !== null && (
        <p role="alert" className="crit-t s">
          {refusedText(error)}
        </p>
      )}
    </form>
  );
}

/** One crew session (config.yaml): its seats, who owns each top folder, and the seats table. */
function CrewSession({
  session,
  config,
  crew,
  folders,
  changes,
  form,
  setForm,
  busy,
  error,
  save,
  close,
}: {
  session: SessionView;
  config: ConfigView;
  crew: Crew | undefined;
  folders: CrewSessionFolders | undefined;
  changes: CrewChanges | undefined;
  form: FormState | null;
  setForm: (f: FormState | null) => void;
  busy: boolean;
  error: string | null;
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
  const mine = form?.sessionId === session.id ? form : null;
  const pickable = mine !== null && roles.find((r) => r.name === mine.role)?.mode === "writer";
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

  function open(editing: SeatInput | null) {
    setRemoving(null);
    setForm(seatForm(config, session.id, editing));
  }

  function toggleTile(name: string) {
    if (!mine) return;
    const glob = `${name}/**`;
    const globs = globsOf(mine.area);
    const next = globs.includes(glob) ? globs.filter((g) => g !== glob) : [...globs, glob];
    setForm({ ...mine, area: next.join(", ") });
  }

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
              onClick={() => open(null)}
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
                  {pickable ? (
                    <button
                      type="button"
                      className="tilepick"
                      aria-pressed={globsOf(mine.area).includes(`${f.name}/**`)}
                      onClick={() => toggleTile(f.name)}
                    >
                      {inner}
                    </button>
                  ) : (
                    inner
                  )}
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
                            <button type="button" disabled={busy} onClick={() => open(input)}>
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
        {mine && changes && (
          <SeatForm
            session={session}
            config={config}
            roles={roles}
            form={mine}
            setForm={setForm}
            busy={busy}
            error={error}
            onSave={(seat) =>
              save(
                session,
                base,
                mine.editId === null
                  ? [...base, seat]
                  : base.map((x) => (x.id === mine.editId ? seat : x)),
                (b) =>
                  mine.editId === null
                    ? addedText(nameOf(seat.id), session.id, b)
                    : savedText(nameOf(seat.id), b),
              )
            }
          />
        )}
        {!mine && error !== null && (
          <p role="alert" className="crit-t s">
            {refusedText(error)}
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
  const validSession =
    /^[a-z][a-z0-9-]{0,30}$/.test(name) &&
    draft.source.trim() !== "" &&
    draft.branch.trim() !== "" &&
    draft.repoId !== "";
  // Read once on mount: Overview's Add agent arrives from another page, so Setup mounts fresh.
  const [requestedSessionId] = useState(() => addAgentParam(window.location.search));
  const [form, setForm] = useState<FormState | null>(() => {
    const target = config.crew?.sessions.find((s) => s.id === requestedSessionId);
    return target ? seatForm(config, target.id) : null;
  });
  useEffect(() => {
    if (
      changes &&
      form?.sessionId === requestedSessionId &&
      addAgentParam(window.location.search) === requestedSessionId
    ) {
      navigate(withoutAddAgentParam(), { replace: true });
    }
  }, [changes, form?.sessionId, requestedSessionId]);
  const [busy, setBusy] = useState(false);
  // Restore only after the form unmounts and its opener is enabled again.
  useEffect(() => {
    if (adding || busy || !focusReturn.current) return;
    const opener = focusReturn.current;
    focusReturn.current = null;
    (opener.isConnected ? opener : addSessionButton.current)?.focus();
  });
  // Where a refusal shows: a session's panel, or (null) the page, for a reload.
  const [failure, setFailure] = useState<{ sessionId: string | null; text: string } | null>(null);
  const crewSessions = allSessions.filter(
    (s) => !closed.includes(s.id) && (inSession(session, s.id) || s.id === requestedSessionId),
  );

  const refetch = () => {
    hub.refetch(RESOURCES.crewChanges.path);
    hub.refetch(RESOURCES.config.path);
    hub.refetch(RESOURCES.crewSessions.path);
    hub.refetch(RESOURCES.crew.path);
  };

  async function addSession() {
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
      setForm(seatForm(currentConfig, done.id));
      dismissSessionForm();
      toast(
        `s/${done.id} added${draft.checkoutStrategy === "separate" ? " with its own checkout" : ""}. Now add its first agent.`,
      );
      refetch();
    } catch (err) {
      const text = errorText(err);
      setFailure({ sessionId: null, text });
      toast(text);
    } finally {
      setBusy(false);
    }
  }

  async function closeSession(id: string, opener: HTMLButtonElement) {
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
      setForm(null);
      refetch();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const save: SaveSeats = async (s, base, seats, toastOf) => {
    setBusy(true);
    setFailure(null);
    try {
      const done = await apiPost<{ backup: string; changes: ReloadResult }>(
        ACTIONS.crewSeats(s.id),
        { base, seats },
      );
      toast(toastOf(done.backup));
      setForm(null);
      refetch();
    } catch (err) {
      setFailure({ sessionId: s.id, text: errorText(err) });
      // Another tab saved first: the next try needs the fresh base.
      if (err instanceof ApiError && err.status === 409) refetch();
    } finally {
      setBusy(false);
    }
  };

  async function reload() {
    setBusy(true);
    setFailure(null);
    try {
      await apiPost<ReloadResult>(ACTIONS.reloadConfig, {});
      toast(RELOADED);
      refetch();
    } catch (err) {
      setFailure({ sessionId: null, text: errorText(err) });
    } finally {
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
              setFailure(null);
            }}
          >
            Add session
          </button>
        ) : (
          <form
            className="seatform sessionform"
            aria-label="Add session"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) dismissSessionForm();
            }}
            onSubmit={(e) => {
              e.preventDefault();
              if (validSession && !busy) void addSession();
            }}
          >
            <fieldset disabled={busy} className="frow">
              <label className="s fg2">
                Repo profile
                <select
                  value={draft.repoId}
                  onChange={(e) => setDraft({ ...draft, repoId: e.target.value })}
                >
                  {config.repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="s fg2">
                Repo
                <input
                  value={draft.source}
                  onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                />
              </label>
              <label className="s fg2">
                Branch
                <input
                  value={draft.branch}
                  onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
                />
              </label>
              <label className="s fg2">
                Checkout
                <select
                  value={draft.checkoutStrategy}
                  onChange={(e) => setDraft({ ...draft, checkoutStrategy: e.target.value })}
                >
                  <option value="shared">use the repo folder (nothing else on it)</option>
                  <option value="separate">make a separate checkout for this branch</option>
                </select>
              </label>
              <label className="s fg2">
                Name
                <input
                  value={draft.id}
                  placeholder={name}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </label>
              <button type="submit" className="primary" disabled={!validSession || busy}>
                {busy ? "Adding session…" : "Add session"}
              </button>
              <button type="button" onClick={dismissSessionForm}>
                Cancel
              </button>
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
      {changes?.error && (
        <p role="alert" className="crit-t s">
          {loadErrorText(changes.error)}
        </p>
      )}
      {changes && changes.restartNeeded.length > 0 && (
        <p className="note wide">{restartText(changes.restartNeeded)}</p>
      )}
      {failure?.sessionId === null && (
        <p role="alert" className="crit-t s">
          {refusedText(failure.text)}
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
          form={form}
          setForm={setForm}
          busy={busy}
          error={failure?.sessionId === s.id ? failure.text : null}
          save={save}
          close={(opener) => void closeSession(s.id, opener)}
        />
      ))}
    </>
  );
}
