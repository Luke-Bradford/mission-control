import {
  type ConfigView,
  errorText,
  type HubSettingsView,
  type NewRepo,
  PLAN_SIGNOFFS,
  type PlanSignoff,
  type RepoPreview,
  type RepoRulesView,
  type SeatInput,
} from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiDelete, apiPost } from "../api.ts";
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
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { plural } from "../fmt.ts";
import {
  ADD_AGENT_PARAM,
  ADD_REPO_PARAM,
  addAgentParam,
  EDIT_SEAT_PARAM,
  editSeatParam,
  navigate,
} from "../router.ts";
import { useReturnFocus } from "../shell/overlays.ts";
import { toast } from "../shell/Toast.tsx";
import { BoardSetup } from "./BoardSetup.tsx";
import { SettingRow } from "./HubSettings.tsx";
import { inputOf, roleLabel, SeatEditor } from "./SeatEditor.tsx";
import { CALL_SIGN_HINT } from "./Sessions.tsx";

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
const PLAN_SIGNOFF_LABELS: Record<PlanSignoff, string> = {
  every: "Every ticket",
  larger: "Larger work only",
  never: "Never",
};

/** Configuration only: cards do not make board, queue, or live-seat reads. */
export function Repos({ config }: { config: ConfigView }) {
  // `?addRepo=1` (First run's First repo) and `?add=<session>` / `?edit=<session>:<seat>` (links
  // from other pages) are read once on mount; each is dropped from the URL after it has been used.
  const [adding, setAdding] = useState<Repo | null | false>(() =>
    new URLSearchParams(window.location.search).has(ADD_REPO_PARAM) ? null : false,
  );
  const [request] = useState(() => ({
    add: addAgentParam(window.location.search),
    edit: editSeatParam(window.location.search),
  }));
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    for (const key of [ADD_REPO_PARAM, ADD_AGENT_PARAM, EDIT_SEAT_PARAM]) q.delete(key);
    const { pathname, hash } = window.location;
    const qs = q.toString();
    if (qs !== window.location.search.slice(1))
      navigate(pathname + (qs ? `?${qs}` : "") + hash, { replace: true });
  }, []);
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
        <AddRepo
          key={adding ? adding.id : "new"}
          repo={adding || undefined}
          config={config}
          close={() => setAdding(false)}
        />
      )}
      {config.repos.map((repo) => (
        <RepoCard
          key={repo.id}
          repo={repo}
          config={config}
          request={request}
          onConvert={() => setAdding(repo)}
        />
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

type SeatRequest = {
  add: string | null;
  edit: { sessionId: string; seatId: string } | null;
};

function RepoCard({
  repo,
  config,
  request,
  onConvert,
}: {
  repo: Repo;
  config: ConfigView;
  request: SeatRequest;
  onConvert: () => void;
}) {
  const session = config.crew?.sessions.find((item) => item.repoId === repo.id);
  const asked = !!session && (request.add === session.id || request.edit?.sessionId === session.id);
  const [open, setOpen] = useState(asked);
  const [guidance, setGuidance] = useState<Guidance>(repo.guidance ?? EMPTY_GUIDANCE);
  const [account, setAccount] = useState(repo.defaultAccountId ?? config.accounts[0]?.id ?? "");
  // A closed card is summary-only. Read its editable rules when the operator opens it.
  const rules = useResource<RepoRulesView>(open ? RESOURCES.repoRules(repo.id) : null);
  const [planSignOff, setPlanSignOff] = useState<PlanSignoff>("never");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    setPlanSignOff((rules.data?.rules.plan_signoff?.value as PlanSignoff | undefined) ?? "never");
    setGuidance(repo.guidance ?? EMPTY_GUIDANCE);
    setAccount(repo.defaultAccountId ?? config.accounts[0]?.id ?? "");
  }, [repo, config.accounts, rules.data]);
  const save = async () => {
    setSaving(true);
    try {
      const savedPlanSignoff = rules.data?.rules.plan_signoff;
      // This write uses the version read with the rules. Do it before /setup can rewrite config.yaml.
      if (savedPlanSignoff && rules.data && planSignOff !== savedPlanSignoff.value) {
        await apiPost(ACTIONS.repoRules(repo.id), {
          base: rules.data.base,
          rules: { plan_signoff: planSignOff },
        });
      }
      const result = await apiPost<{ backup: string }>(ACTIONS.repoSetup(repo.id), {
        defaultAccountId: account || null,
        guidance,
      });
      if (savedPlanSignoff) {
        hub.refetch(RESOURCES.repoRules(repo.id).path);
      }
      toast(`Saved ${repo.id}. Backup: ${result.backup}.`);
      hub.refetch(RESOURCES.config.path);
    } catch (error) {
      toast(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  const [closing, setClosing] = useState(false);
  const closeCrewSession = async (id: string) => {
    if (!window.confirm(`Close session ${id}? Its seats stop and the checkout is removed.`)) return;
    setClosing(true);
    try {
      await apiPost(ACTIONS.closeSession(id), {});
      toast(`Session ${id} closed.`);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crewChanges.path);
    } catch (error) {
      toast(errorText(error));
    } finally {
      setClosing(false);
    }
  };
  const removeRepo = async () => {
    if (!window.confirm(`Remove ${repo.id}?`)) return;
    setRemoving(true);
    try {
      await apiDelete(ACTIONS.removeRepo(repo.id));
      toast(`${repo.id} will be removed after restart.`);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crewChanges.path);
    } catch (error) {
      toast(errorText(error));
    } finally {
      setRemoving(false);
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
            <Seats
              session={session}
              config={config}
              defaultAccount={account}
              request={asked ? request : { add: null, edit: null }}
            />
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
            {rules.data?.rules.plan_signoff && (
              <label>
                Plan sign-off
                <select
                  value={planSignOff}
                  onChange={(e) => setPlanSignOff(e.target.value as PlanSignoff)}
                >
                  {PLAN_SIGNOFFS.map((v) => (
                    <option key={v} value={v}>
                      {PLAN_SIGNOFF_LABELS[v]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Checkout folder
              <input value={session?.checkout ?? ""} readOnly placeholder="Observed repo" />
            </label>
          </div>
          <RepoSettings repoId={repo.id} />
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
            <button
              type="button"
              className="sm warn"
              disabled={removing}
              onClick={() => void removeRepo()}
            >
              {removing ? "Removing…" : "Remove repo"}
            </button>
            {session && (
              <button
                type="button"
                className="sm warn"
                disabled={closing}
                onClick={() => void closeCrewSession(session.id)}
              >
                {closing ? "Closing…" : "Close session"}
              </button>
            )}
          </div>
          <details className="repo-board-configuration">
            <summary>Board configuration</summary>
            <BoardSetup repoId={repo.id} github={repo.github} />
          </details>
        </>
      )}
    </article>
  );
}

/** The settings only config.yaml held: status map, autonomy and FLIGHT powers, each with when it applies. */
function RepoSettings({ repoId }: { repoId: string }) {
  const settings = useResource<HubSettingsView>(RESOURCES.hubSettings).data;
  if (!settings) return null;
  const own = settings.repos[repoId] ?? {};
  return (
    <fieldset className="fgroup repo-settings">
      <legend>Repo settings</legend>
      {(["repo.status_map", "repo.autonomy", "repo.flight_powers"] as const).map((key) => (
        <SettingRow
          key={key}
          settingKey={key}
          repoId={repoId}
          value={own[key]}
          base={settings.base}
        />
      ))}
    </fieldset>
  );
}

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

function Seats({
  session,
  config,
  defaultAccount,
  request,
}: {
  session: Session;
  config: ConfigView;
  defaultAccount: string;
  request: SeatRequest;
}) {
  const changesRead = useResource<{ sessions: { id: string; seats: SeatInput[] }[] }>(
    RESOURCES.crewChanges,
  );
  const changes = changesRead.data;
  const wanted = request.edit?.sessionId === session.id ? request.edit.seatId : null;
  const wantedSeat = session.seats.find((item) => item.id === wanted);
  const editSeed = useRef<SeatInput | undefined>(
    wantedSeat === undefined ? undefined : inputOf(wantedSeat),
  );
  const [editing, setEditing] = useState<string | null>(wantedSeat?.id ?? null);
  const [adding, setAdding] = useState(request.add === session.id);
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
                    editSeed.current = seat;
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
      {(adding || editing) && !changes && (
        // The config view leaves out each seat's effort; only the crew changes read has it, so
        // the editor waits for it rather than saving a seat without its effort.
        <p className="muted s" role="status">
          {changesRead.error
            ? `Could not read the seats: ${changesRead.error.message}`
            : "Loading the seats…"}
        </p>
      )}
      {(adding || editing) && changes && (
        <SeatEditor
          key={editing ?? "new"}
          seat={
            editing ? (base.find((item) => item.id === editing) ?? editSeed.current) : undefined
          }
          missing={!!editing && !base.some((item) => item.id === editing)}
          taken={base.map((item) => item.id)}
          config={config}
          defaultAccount={defaultAccount}
          onCancel={closeForm}
          onSave={(seat) =>
            // A gone seat is only ever added back; a list equal to the base is never sent.
            write(
              editing && base.some((item) => item.id === editing)
                ? base.map((item) => (item.id === editing ? seat : item))
                : [...base, seat],
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
/** The live checks only read, so a dropped connection there means nothing was saved. */
const CHECK_LOST_TEXT =
  "The connection dropped. Nothing was saved and your entries are kept. Run the checks again.";
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
  const fail = (cause: unknown, readOnly = false) => {
    // The live checks only read: a 5xx there is the server's own answer (GitHub said no), and
    // only an answer that never came is a lost connection.
    const uncertain = readOnly
      ? !(cause instanceof ApiError)
      : isUncertain(cause instanceof ApiError ? cause.status : undefined);
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
        fail(cause, true);
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
        ? step === 3
          ? "Check did not finish"
          : "Result unknown"
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
        {failure?.uncertain && issues.length === 0 && (
          <p className="s">{step === 3 ? CHECK_LOST_TEXT : UNCERTAIN_TEXT}</p>
        )}
        {failure && !failure.uncertain && issues.length === 0 && step === 3 && (
          <p className="s">Nothing was saved and your entries are kept.</p>
        )}
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
