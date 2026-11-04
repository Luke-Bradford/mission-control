import {
  type AccountModelsView,
  type ConfigView,
  type Crew,
  errorText,
  type MapSnapshot,
  type NewRepo,
  type RepoPreview,
  type SeatInput,
} from "@mc/core";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
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
import { callSign } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { plural } from "../fmt.ts";
import { OwnershipLens } from "../lenses/lenses.tsx";
import { useReturnFocus } from "../shell/overlays.ts";
import { toast } from "../shell/Toast.tsx";
import { BoardSetup } from "./BoardSetup.tsx";
import { CALL_SIGN, CALL_SIGN_HINT } from "./Sessions.tsx";

type Repo = ConfigView["repos"][number];
type Session = NonNullable<ConfigView["crew"]>["sessions"][number];
type Guidance = NonNullable<Repo["guidance"]>;
const EMPTY_GUIDANCE: Guidance = {
  priority: [],
  milestone: [],
  labels: [],
  labelMode: "any",
  avoid: [],
  direction: "",
};

/** Configuration only: cards do not make board, queue, or live-seat reads. */
export function Repos({ config }: { config: ConfigView }) {
  const [adding, setAdding] = useState<Repo | null | false>(false);
  return (
    <section className="setup-repos" aria-label="Repos and seats">
      <div className="setup-repos-head">
        <span className="cap">Repos &amp; seats</span>
        <button
          type="button"
          className="primary sm"
          onClick={() => setAdding(adding === false ? null : false)}
        >
          + Add repo
        </button>
      </div>
      {adding !== false && (
        <AddRepo repo={adding || undefined} config={config} close={() => setAdding(false)} />
      )}
      {config.repos.map((repo) => (
        <RepoCard key={repo.id} repo={repo} config={config} onConvert={() => setAdding(repo)} />
      ))}
    </section>
  );
}

function Chips({
  values,
  set,
  label,
}: {
  values: string[];
  set: (v: string[]) => void;
  label: string;
}) {
  const [value, setValue] = useState("");
  return (
    <fieldset className="repo-pick">
      <legend className="sr-only">{label}</legend>
      {values.map((item) => (
        <span className="chip" key={item}>
          {item}{" "}
          <button
            type="button"
            aria-label={`Remove ${item}`}
            onClick={() => set(values.filter((x) => x !== item))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={value}
        placeholder="+ add"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const item = value.trim();
          if (item && !values.includes(item)) set([...values, item]);
          setValue("");
        }}
      />
    </fieldset>
  );
}

function RepoCard({
  repo,
  config,
  onConvert,
}: {
  repo: Repo;
  config: ConfigView;
  onConvert: () => void;
}) {
  const session = config.crew?.sessions.find((item) => item.repoId === repo.id);
  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState<Guidance>(repo.guidance ?? EMPTY_GUIDANCE);
  const [account, setAccount] = useState(repo.defaultAccountId ?? config.accounts[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setGuidance(repo.guidance ?? EMPTY_GUIDANCE);
    setAccount(repo.defaultAccountId ?? config.accounts[0]?.id ?? "");
  }, [repo, config.accounts]);
  const save = async () => {
    setSaving(true);
    try {
      const result = await apiPost<{ backup: string }>(ACTIONS.repoSetup(repo.id), {
        defaultAccountId: account || null,
        guidance,
      });
      toast(`Saved ${repo.id}. Backup: ${result.backup}.`);
      hub.refetch(RESOURCES.config.path);
    } catch (error) {
      toast(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <article className="repo-card" aria-label={repo.id}>
      <button
        type="button"
        className="repo-card-title"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <b>{repo.id}</b>
        <span>{session ? "Crew" : "Observed"}</span>
        <span>account {account || "—"}</span>
        <span>{session ? plural(session.seats.length, "seat") : "no seats"}</span>
        <span className="repo-card-toggle" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <>
          {session ? (
            <Seats session={session} config={config} defaultAccount={account} />
          ) : (
            <Observed repo={repo} config={config} onConvert={onConvert} />
          )}
          <div className="repo-fields">
            <label>
              Default account
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">No default</option>
                {config.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Checkout folder
              <input value={session?.checkout ?? ""} readOnly placeholder="Observed repo" />
            </label>
          </div>
          <div className="cap repo-guidance-title">Work guidance · guidance, not rules</div>
          <div className="repo-guidance">
            <div>
              <span>Priority</span>
              <Chips
                label="Priority"
                values={guidance.priority}
                set={(priority) => setGuidance({ ...guidance, priority })}
              />
            </div>
            <div>
              <span>Milestone</span>
              <Chips
                label="Milestone"
                values={guidance.milestone}
                set={(milestone) => setGuidance({ ...guidance, milestone })}
              />
            </div>
            <fieldset>
              <legend>Labels · match mode</legend>
              <label>
                <input
                  type="radio"
                  checked={guidance.labelMode === "any"}
                  onChange={() => setGuidance({ ...guidance, labelMode: "any" })}
                />{" "}
                any of
              </label>
              <label>
                <input
                  type="radio"
                  checked={guidance.labelMode === "all"}
                  onChange={() => setGuidance({ ...guidance, labelMode: "all" })}
                />{" "}
                all of
              </label>
              <Chips
                label="Labels"
                values={guidance.labels}
                set={(labels) => setGuidance({ ...guidance, labels })}
              />
            </fieldset>
            <div>
              <span>Avoid</span>
              <Chips
                label="Avoid"
                values={guidance.avoid}
                set={(avoid) => setGuidance({ ...guidance, avoid })}
              />
            </div>
            <label className="repo-direction">
              <span>Direction</span>
              <textarea
                value={guidance.direction}
                onChange={(e) => setGuidance({ ...guidance, direction: e.target.value })}
              />
            </label>
          </div>
          <div className="repo-save">
            <button type="button" className="sm" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save guidance"}
            </button>
          </div>
          <details className="repo-board-configuration">
            <summary>Board configuration</summary>
            <BoardSetup repoId={repo.id} github={repo.github} />
          </details>
          {session && <RepoOwnership repoId={repo.id} />}
        </>
      )}
    </article>
  );
}

/** The repo's areas and hard-rule files, read from its map when the section is opened. */
function RepoOwnership({ repoId }: { repoId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="repo-ownership"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Ownership · areas and hard-rule files</summary>
      {open && <OwnershipTable repoId={repoId} />}
    </details>
  );
}

function OwnershipTable({ repoId }: { repoId: string }) {
  const map = useResource<MapSnapshot>(RESOURCES.repoMap(repoId));
  const rows = useResource<Crew>(RESOURCES.crew).data?.rows;
  const names = useMemo(
    () => Object.fromEntries((rows ?? []).map((r) => [r.id, callSign(r)])),
    [rows],
  );
  const indices = useMemo(
    () => Object.fromEntries((rows ?? []).map((r) => [r.id, r.index])),
    [rows],
  );
  if (map.data)
    return <OwnershipLens snapshot={map.data} names={names} indices={indices} onFocus={noFocus} />;
  return map.error ? (
    <p className="note">
      Could not read the map for {repoId}: {map.error.message}
    </p>
  ) : (
    <p className="note">Loading ownership…</p>
  );
}
const noFocus = () => {};

function Observed({
  repo,
  config,
  onConvert,
}: {
  repo: Repo;
  config: ConfigView;
  onConvert: () => void;
}) {
  const loops = config.loops.filter((loop) => loop.repoId === repo.id);
  return (
    <div className="repo-observed">
      <p className="note">
        <b>External loop, read-only:</b>{" "}
        {loops.length
          ? loops.map((loop) => `${loop.kind} · ${loop.launchdLabel}`).join(", ")
          : "No external loop configured."}
      </p>
      <button type="button" className="sm" onClick={onConvert}>
        Convert to crew repo
      </button>
    </div>
  );
}

function roleLabel(config: ConfigView, role: string): string {
  const found = config.crew?.roles?.find((item) => item.name === role);
  return found?.here ? `${found.here} (${role})` : role;
}
const inputOf = (seat: Session["seats"][number]): SeatInput => ({
  id: seat.id,
  ...(seat.displayCallSign === null || seat.displayCallSign === undefined
    ? {}
    : { displayCallSign: seat.displayCallSign }),
  ...(seat.focus === null || seat.focus === undefined ? {} : { focus: seat.focus }),
  role: seat.role,
  accountId: seat.accountId,
  model: seat.model,
  ...(seat.mode === "scratch" ? { mode: "scratch" as const } : {}),
  area: seat.area,
});
/** What the server's schema would refuse, found before sending; the server stays the judge. */
function seatIssues(
  form: SeatInput,
  adding: boolean,
  taken: string[],
  ids: Record<"sign" | "role" | "account" | "model", string>,
): FieldIssue[] {
  const found: FieldIssue[] = [];
  if (adding) {
    if (!CALL_SIGN.test(form.id))
      found.push({
        id: ids.sign,
        message: `Call sign: ${CALL_SIGN_HINT}, starting with a letter.`,
      });
    else if (taken.includes(form.id))
      found.push({ id: ids.sign, message: "Call sign is already used by a seat in this repo." });
  }
  if (!form.role) found.push({ id: ids.role, message: "Role is required." });
  if (!form.accountId)
    found.push({ id: ids.account, message: "Account: none is configured; add one in Accounts." });
  if (!form.model.trim())
    found.push({
      id: ids.model,
      message: "Model is required. Pick an account that has discovered models.",
    });
  return found;
}

/**
 * The add and edit seat form. The draft is local: a refused or lost save leaves what was typed and
 * says why here, not only in a toast. `onSave` resolves when the write is done and rejects with
 * the failure; while it is out the fields are held and a second submit is ignored.
 */
function SeatEditor({
  seat,
  taken,
  config,
  defaultAccount,
  onCancel,
  onSave,
}: {
  seat?: SeatInput;
  taken: string[];
  config: ConfigView;
  defaultAccount: string;
  onCancel: () => void;
  onSave: (seat: SeatInput) => Promise<void>;
}) {
  const firstRole = config.crew?.roles?.[0]?.name ?? "";
  const [form, setForm] = useState<SeatInput>(
    seat ?? { id: "", role: firstRole, accountId: defaultAccount, model: "", area: [] },
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ text: string; uncertain: boolean } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const guard = useSubmitGuard();
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    alive.current = true;
    // Opens at its first control, scrolled into view.
    const first = formRef.current?.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled)",
    );
    first?.focus();
    first?.scrollIntoView?.({ block: "nearest" });
    return () => {
      alive.current = false;
    };
  }, []);
  const base = useId();
  const ids = {
    sign: `${base}-sign`,
    role: `${base}-role`,
    account: `${base}-account`,
    model: `${base}-model`,
    effort: `${base}-effort`,
  };
  const catalog = useResource<AccountModelsView[]>(RESOURCES.allAccountModels).data;
  const options = catalog?.find((account) => account.accountId === form.accountId)?.models ?? [];
  // An old seat may have a model that has since left a provider catalog.  Keep it visible while
  // editing that seat, but never make it a choice for a new one.
  const models = useMemo(
    () =>
      seat && form.model && !options.some((option) => option.model === form.model)
        ? [{ model: form.model, efforts: [] }, ...options]
        : options,
    [seat, form.model, options],
  );
  const efforts = options.find((option) => option.model === form.model)?.efforts ?? [];
  useEffect(() => {
    if (!seat && form.model === "" && options[0]) setForm({ ...form, model: options[0].model });
  }, [seat, form, options]);
  const issues = attempted ? seatIssues(form, !seat, taken, ids) : [];
  const signError = issueOf(issues, ids.sign);
  const roleError = issueOf(issues, ids.role);
  const accountError = issueOf(issues, ids.account);
  const modelError = issueOf(issues, ids.model);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!guard.take()) return;
    setAttempted(true);
    if (seatIssues(form, !seat, taken, ids).length > 0) {
      guard.release();
      setFailure(null);
      setFocusKey((key) => key + 1);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await onSave(form);
    } catch (cause) {
      if (alive.current) {
        setFailure({
          text: errorText(cause),
          uncertain: isUncertain(cause instanceof ApiError ? cause.status : undefined),
        });
        setFocusKey((key) => key + 1);
      }
    } finally {
      guard.release();
      if (alive.current) setSaving(false);
    }
  };
  const title =
    issues.length > 0 ? "Fix before saving" : failure?.uncertain ? "Result unknown" : "Not saved";
  return (
    <form
      ref={formRef}
      className="fform fform-640"
      noValidate
      aria-label={seat ? `Edit ${seat.id}` : "Add seat"}
      onSubmit={(event) => void submit(event)}
    >
      <fieldset className="fgroup">
        <legend>Seat</legend>
        <div className="fpair">
          <div className="ffield">
            <label htmlFor={ids.sign}>Call sign</label>
            <input
              {...fieldProps(ids.sign, signError, `${ids.sign}-hint`)}
              value={form.id}
              disabled={!!seat || saving}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
            />
            <span id={`${ids.sign}-hint`} className="fhint muted xs">
              {seat
                ? "A call sign cannot change once the seat exists."
                : `${CALL_SIGN_HINT}, starting with a letter.`}
            </span>
            <FieldError id={ids.sign} error={signError} />
          </div>
          <div className="ffield">
            <label htmlFor={ids.role}>Role</label>
            <select
              {...fieldProps(ids.role, roleError)}
              value={form.role}
              disabled={saving}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {config.crew?.roles?.map((role) => (
                <option key={role.name} value={role.name}>
                  {roleLabel(config, role.name)}
                </option>
              ))}
            </select>
            <FieldError id={ids.role} error={roleError} />
          </div>
        </div>
      </fieldset>
      <fieldset className="fgroup">
        <legend>Account and model</legend>
        <div className="fpair">
          <div className="ffield">
            <label htmlFor={ids.account}>Account</label>
            <select
              {...fieldProps(ids.account, accountError)}
              value={form.accountId}
              disabled={saving}
              onChange={(e) =>
                setForm({ ...form, accountId: e.target.value, model: "", effort: undefined })
              }
            >
              {config.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.id === defaultAccount ? `${account.id} (repo default)` : account.id}
                </option>
              ))}
            </select>
            <FieldError id={ids.account} error={accountError} />
          </div>
          <div className="ffield">
            <label htmlFor={ids.model}>Model</label>
            <select
              {...fieldProps(ids.model, modelError)}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value, effort: undefined })}
              disabled={saving || models.length === 0}
            >
              <option value="">No discovered models</option>
              {models.map((model) => (
                <option key={model.model} value={model.model}>
                  {model.model}
                </option>
              ))}
            </select>
            <FieldError id={ids.model} error={modelError} />
          </div>
        </div>
        <div className="fpair">
          <div className="ffield">
            <label htmlFor={ids.effort}>Effort</label>
            <select
              id={ids.effort}
              value={form.effort ?? ""}
              disabled={saving}
              onChange={(e) => setForm({ ...form, effort: e.target.value || undefined })}
            >
              <option value="">CLI default</option>
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
          <div className="ffield">
            <label className="ffield-check">
              <input type="checkbox" checked disabled /> Enabled
            </label>
          </div>
        </div>
      </fieldset>
      <ErrorSummary
        title={title}
        issues={issues}
        message={failure?.text ?? null}
        focusKey={focusKey}
      >
        {failure?.uncertain && issues.length === 0 && <p className="s">{UNCERTAIN_TEXT}</p>}
      </ErrorSummary>
      {saving && (
        <p role="status" className="fstatus s">
          Saving seat…
        </p>
      )}
      <div className="fact">
        <button className="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save seat"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
function Seats({
  session,
  config,
  defaultAccount,
}: {
  session: Session;
  config: ConfigView;
  defaultAccount: string;
}) {
  const changes = useResource<{ sessions: { id: string; seats: SeatInput[] }[] }>(
    RESOURCES.crewChanges,
  ).data;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Where focus goes when the form closes: the button that opened it, or the add button if that went.
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const closeForm = () => {
    restore.current = true;
    setEditing(null);
    setAdding(false);
  };
  useEffect(() => {
    if (adding || editing || !restore.current) return;
    restore.current = false;
    const target = opener.current?.isConnected ? opener.current : addButton.current;
    target?.focus();
  }, [adding, editing]);
  const base =
    changes?.sessions.find((item) => item.id === session.id)?.seats ?? session.seats.map(inputOf);
  /** Writes the seat list; rejects with the failure so a form can show it where the operator is. */
  const write = async (seats: SeatInput[]) => {
    try {
      const result = await apiPost<{ backup: string }>(ACTIONS.crewSeats(session.id), {
        base,
        seats,
      });
      toast(`Seats saved. Backup: ${result.backup}.`);
      closeForm();
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crewChanges.path);
    } catch (error) {
      // A lost answer or a conflict: reread what is saved before another try.
      const status = error instanceof ApiError ? error.status : undefined;
      if (isUncertain(status) || status === 409) {
        hub.refetch(RESOURCES.config.path);
        hub.refetch(RESOURCES.crewChanges.path);
      }
      throw error;
    }
  };
  const remove = (seats: SeatInput[]) =>
    void write(seats).catch((error) =>
      toast(
        isUncertain(error instanceof ApiError ? error.status : undefined)
          ? `${errorText(error)} ${UNCERTAIN_TEXT}`
          : errorText(error),
      ),
    );
  return (
    <section className="repo-seats" aria-label={`Seats for ${session.id}`}>
      <div className="cap">Seats</div>
      <table>
        <thead>
          <tr>
            <th>Call sign</th>
            <th>Role</th>
            <th>Model</th>
            <th>Effort</th>
            <th>Account</th>
            <th>Enabled</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {base.map((seat) => (
            <tr key={seat.id}>
              <td>{seat.id}</td>
              <td>{roleLabel(config, seat.role)}</td>
              <td>{seat.model}</td>
              <td>{seat.effort ?? "CLI default"}</td>
              <td>{seat.accountId === defaultAccount ? "repo default" : seat.accountId}</td>
              <td>
                <input type="checkbox" checked readOnly aria-label={`${seat.id} enabled`} />
              </td>
              <td>
                <button
                  type="button"
                  className="sm"
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setEditing(seat.id);
                    setAdding(false);
                  }}
                >
                  Edit
                </button>{" "}
                <button
                  type="button"
                  className="sm"
                  onClick={() => remove(base.filter((item) => item.id !== seat.id))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(adding || editing) && (
        <SeatEditor
          key={editing ?? "new"}
          seat={editing ? base.find((item) => item.id === editing) : undefined}
          taken={base.map((item) => item.id)}
          config={config}
          defaultAccount={defaultAccount}
          onCancel={closeForm}
          onSave={(seat) =>
            write(
              editing ? base.map((item) => (item.id === editing ? seat : item)) : [...base, seat],
            )
          }
        />
      )}
      {!adding && !editing && (
        <button
          ref={addButton}
          type="button"
          className="sm"
          onClick={(event) => {
            opener.current = event.currentTarget;
            setAdding(true);
          }}
        >
          + Add seat to this repo
        </button>
      )}
    </section>
  );
}

type CheckState = "idle" | "pending" | "pass" | "fail";
const CHECK_TEXT: Record<CheckState, string> = {
  idle: "Not run",
  pending: "Pending",
  pass: "Pass",
  fail: "Fail",
};
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPO_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
const STEP_NAMES = ["repo", "checkout folder", "live checks", "mode and account"] as const;

/**
 * Four explicit steps keep all read-only checks ahead of config and crew writes. Every value
 * lives here, not in a step, so a refused check or write, or a lost connection, leaves them all.
 */
function AddRepo({ repo, config, close }: { repo?: Repo; config: ConfigView; close: () => void }) {
  const [github, setGithub] = useState(repo?.github ?? "");
  const [project, setProject] = useState(repo ? String(repo.project) : "");
  const [id, setId] = useState(repo?.id ?? "");
  const [source, setSource] = useState("");
  const [branch, setBranch] = useState("main");
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<"observed" | "crew">(repo ? "crew" : "observed");
  const [account, setAccount] = useState(repo?.defaultAccountId ?? config.accounts[0]?.id ?? "");
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [checks, setChecks] = useState<{ repo: CheckState; checkout: CheckState }>({
    repo: "idle",
    checkout: "idle",
  });
  const [failure, setFailure] = useState<{ text: string; uncertain: boolean } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const guard = useSubmitGuard();
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  const base = useId();
  const ids = {
    github: `${base}-github`,
    project: `${base}-project`,
    id: `${base}-id`,
    source: `${base}-source`,
    branch: `${base}-branch`,
    mode: `${base}-mode`,
    account: `${base}-account`,
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Focus goes back to the opener when this closes, if it was lost with the form.
  useReturnFocus(true);
  // Each step starts at its first control (or its action), so the keyboard continues where the eyes are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes
  useEffect(() => {
    const target = formRef.current?.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled), button.primary:not(:disabled)",
    );
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
  }, [step]);
  const stepIssues = (at: number): FieldIssue[] => {
    const found: FieldIssue[] = [];
    if (at === 1) {
      if (!REPO_PATTERN.test(github))
        found.push({ id: ids.github, message: "GitHub repo must look like owner/name." });
      if (!(Number.isInteger(Number(project)) && Number(project) > 0))
        found.push({ id: ids.project, message: "Project number must be a whole number above 0." });
      if (!repo && !REPO_ID_PATTERN.test(id.trim()))
        found.push({
          id: ids.id,
          message: `Repo id: ${CALL_SIGN_HINT}, starting with a letter, at most 31 characters.`,
        });
    }
    if (at === 2) {
      if (source.trim() === "")
        found.push({ id: ids.source, message: "Checkout folder is required." });
      if (branch.trim() === "") found.push({ id: ids.branch, message: "Branch is required." });
    }
    if (at === 4 && !account)
      found.push({ id: ids.account, message: "Default account is required: add one in Accounts." });
    return found;
  };
  const issues = attempted ? stepIssues(step) : [];
  const resetChecks = () => {
    // A check still out is now stale: its answer is dropped, and a new run may start at once.
    latest.current++;
    guard.release();
    setBusy(false);
    setPreview(null);
    setChecks({ repo: "idle", checkout: "idle" });
    setFailure(null);
  };
  const go = (to: number) => {
    setStep(to);
    setAttempted(false);
    setFailure(null);
  };
  const next = (to: number) => {
    if (stepIssues(step).length > 0) {
      setAttempted(true);
      setFailure(null);
      setFocusKey((key) => key + 1);
      return;
    }
    go(to);
  };
  const fail = (cause: unknown) => {
    const uncertain = isUncertain(cause instanceof ApiError ? cause.status : undefined);
    setFailure({ text: errorText(cause), uncertain });
    setFocusKey((key) => key + 1);
    return uncertain;
  };
  const runChecks = async () => {
    if (!guard.take()) return;
    const mine = ++latest.current;
    setBusy(true);
    setFailure(null);
    setPreview(null);
    setChecks({ repo: "pending", checkout: "idle" });
    let stage: "repo" | "checkout" = "repo";
    try {
      const found = await apiPost<RepoPreview>(ACTIONS.previewRepo, {
        github,
        project: Number(project),
      });
      if (mine !== latest.current) return;
      stage = "checkout";
      setChecks({ repo: "pass", checkout: "pending" });
      await apiPost(ACTIONS.previewCheckout, {
        github,
        source: source.trim(),
        branch: branch.trim(),
        defaultBranch: found.defaultBranch,
      });
      if (mine === latest.current) {
        setPreview(found);
        setChecks({ repo: "pass", checkout: "pass" });
        go(4);
      }
    } catch (cause) {
      if (mine === latest.current) {
        setChecks((now) => ({ ...now, [stage]: "fail" }));
        fail(cause);
      }
    } finally {
      if (mine === latest.current) {
        guard.release();
        if (alive.current) setBusy(false);
      }
    }
  };
  const submit = async () => {
    if (!preview) return;
    if (stepIssues(4).length > 0) {
      setAttempted(true);
      setFailure(null);
      setFocusKey((key) => key + 1);
      return;
    }
    if (!guard.take()) return;
    setBusy(true);
    setFailure(null);
    try {
      const repoId = id.trim();
      const body = {
        ...(repo
          ? {}
          : {
              repo: {
                id: repoId,
                github,
                project: Number(project),
                statusMap: preview.proposedStatusMap,
              } satisfies NewRepo,
            }),
        repoId,
        defaultAccountId: account,
        guidance: EMPTY_GUIDANCE,
        checkout: { source: source.trim(), branch: branch.trim() },
        session: mode === "crew" ? { id: repoId, checkoutStrategy: "shared" as const } : null,
      };
      await apiPost(ACTIONS.onboardRepo, body);
      toast(repo ? `Converted ${repoId} to a crew repo.` : `Added ${repoId}.`);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crewChanges.path);
      hub.refetch(RESOURCES.crewSessions.path);
      close();
    } catch (cause) {
      // The server may have written before the answer was lost: read what is saved before a retry.
      if (fail(cause)) {
        hub.refetch(RESOURCES.config.path);
        hub.refetch(RESOURCES.crewChanges.path);
        hub.refetch(RESOURCES.crewSessions.path);
      }
    } finally {
      guard.release();
      if (alive.current) setBusy(false);
    }
  };
  const act = () => {
    if (step === 1) next(2);
    else if (step === 2) next(3);
    else if (step === 3) void runChecks();
    else void submit();
  };
  const repoId = id.trim();
  const title =
    issues.length > 0
      ? "Fix before continuing"
      : failure?.uncertain
        ? "Result unknown"
        : step === 3
          ? "A check failed"
          : "Not saved";
  const githubError = issueOf(issues, ids.github);
  const projectError = issueOf(issues, ids.project);
  const idError = issueOf(issues, ids.id);
  const sourceError = issueOf(issues, ids.source);
  const branchError = issueOf(issues, ids.branch);
  const accountError = issueOf(issues, ids.account);
  return (
    <form
      ref={formRef}
      className="fform fform-800 repo-stepper"
      noValidate
      aria-label={repo ? `Convert ${repo.id} to crew repo` : "Add repo"}
      onSubmit={(event) => {
        event.preventDefault();
        act();
      }}
    >
      <ol className="fsteps" aria-label="Steps">
        {STEP_NAMES.map((name, index) => (
          <li
            key={name}
            className={step >= index + 1 ? "on" : ""}
            aria-current={step === index + 1 ? "step" : undefined}
          >
            {index + 1} {name}
          </li>
        ))}
      </ol>
      {step > 1 && (
        <p className="feffect s">
          <b>Repo:</b> {github} · project {project}
          {repo ? "" : ` · id ${repoId}`}
          {step > 2 && (
            <>
              <br />
              <b>Checkout:</b> {source.trim()} · branch {branch.trim()}
            </>
          )}
        </p>
      )}
      <div className="fcontent">
        {step === 1 && (
          <fieldset className="fgroup">
            <legend>Repo</legend>
            <div className="fpair">
              <div className="ffield">
                <label htmlFor={ids.github}>GitHub repo</label>
                <input
                  {...fieldProps(ids.github, githubError)}
                  value={github}
                  disabled={!!repo}
                  placeholder="owner/name"
                  onChange={(e) => {
                    setGithub(e.target.value);
                    resetChecks();
                  }}
                />
                <FieldError id={ids.github} error={githubError} />
              </div>
              <div className="ffield">
                <label htmlFor={ids.project}>Project number</label>
                <input
                  {...fieldProps(ids.project, projectError)}
                  inputMode="numeric"
                  disabled={!!repo}
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    resetChecks();
                  }}
                />
                <FieldError id={ids.project} error={projectError} />
              </div>
            </div>
            {!repo && (
              <div className="ffield">
                <label htmlFor={ids.id}>Repo id</label>
                <input
                  {...fieldProps(ids.id, idError, `${ids.id}-hint`)}
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
                <span id={`${ids.id}-hint`} className="fhint muted xs">
                  The short name Mission Control uses: {CALL_SIGN_HINT}.
                </span>
                <FieldError id={ids.id} error={idError} />
              </div>
            )}
          </fieldset>
        )}
        {step === 2 && (
          <fieldset className="fgroup">
            <legend>Checkout folder</legend>
            <div className="ffield">
              <label htmlFor={ids.source}>Checkout folder</label>
              <input
                {...fieldProps(ids.source, sourceError)}
                value={source}
                placeholder="/absolute/path/to/clone"
                onChange={(e) => {
                  setSource(e.target.value);
                  resetChecks();
                }}
              />
              <FieldError id={ids.source} error={sourceError} />
            </div>
            <div className="ffield">
              <label htmlFor={ids.branch}>Branch</label>
              <input
                {...fieldProps(ids.branch, branchError)}
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  resetChecks();
                }}
              />
              <FieldError id={ids.branch} error={branchError} />
            </div>
          </fieldset>
        )}
        {step === 3 && (
          <fieldset className="fgroup">
            <legend>Live checks</legend>
            <p className="note s">
              Checks verify the local git repository, origin, branch, GitHub access, CI workflow and
              Project board before anything is written.
            </p>
            <ul className="fchecks" aria-label="Live check results">
              <li>
                <span>GitHub repo and Project board</span>
                <b className={checks.repo === "fail" ? "crit-t" : ""}>{CHECK_TEXT[checks.repo]}</b>
              </li>
              <li>
                <span>Checkout folder and branch</span>
                <b className={checks.checkout === "fail" ? "crit-t" : ""}>
                  {CHECK_TEXT[checks.checkout]}
                </b>
              </li>
            </ul>
          </fieldset>
        )}
        {step === 4 && preview && (
          <fieldset className="fgroup">
            <legend>Mode and account</legend>
            <p className="note s">{preview.projectTitle || github} · Project board verified.</p>
            <div className="fpair">
              <div className="ffield">
                <label htmlFor={ids.mode}>Mode</label>
                <select
                  id={ids.mode}
                  value={mode}
                  disabled={!!repo || busy}
                  onChange={(e) => setMode(e.target.value as "observed" | "crew")}
                >
                  <option value="observed">Observed</option>
                  <option value="crew">Crew</option>
                </select>
              </div>
              <div className="ffield">
                <label htmlFor={ids.account}>Default account</label>
                <select
                  {...fieldProps(ids.account, accountError)}
                  value={account}
                  disabled={busy}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  {config.accounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
                <FieldError id={ids.account} error={accountError} />
              </div>
            </div>
            <div className="feffect s">
              <b>Will write</b>
              <ul>
                <li>
                  {repo
                    ? `${repo.id} stays in config.yaml and becomes a crew repo.`
                    : `Repo ${repoId} (${github}, project ${project}) added to config.yaml.`}
                </li>
                <li>
                  Checkout {source.trim()} on branch {branch.trim()}.
                </li>
                <li>
                  {mode === "crew"
                    ? `Crew session ${repoId} on a shared checkout, with no seats yet.`
                    : "Observed: no crew session and no seats."}
                </li>
                <li>Default account {account || "—"}; work guidance starts empty.</li>
              </ul>
            </div>
          </fieldset>
        )}
      </div>
      <ErrorSummary
        title={title}
        issues={issues}
        message={failure?.text ?? null}
        focusKey={focusKey}
      >
        {failure?.uncertain && issues.length === 0 && <p className="s">{UNCERTAIN_TEXT}</p>}
      </ErrorSummary>
      {busy && (
        <p role="status" className="fstatus s">
          {step === 3 ? "Running live checks…" : "Saving…"}
        </p>
      )}
      <div className="fact">
        {step > 1 && (
          <button
            type="button"
            disabled={busy && step !== 3}
            onClick={() => {
              if (step === 3) resetChecks();
              go(step - 1);
            }}
          >
            Back
          </button>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {step === 1
            ? "Next: checkout"
            : step === 2
              ? "Next: live checks"
              : step === 3
                ? busy
                  ? "Checking…"
                  : "Run live checks"
                : busy
                  ? "Saving…"
                  : repo
                    ? "Convert to crew repo"
                    : "Add repo"}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
