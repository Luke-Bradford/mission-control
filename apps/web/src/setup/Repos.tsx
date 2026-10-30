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
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { callSign } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { OwnershipLens } from "../lenses/lenses.tsx";
import { toast } from "../shell/Toast.tsx";
import { BoardSetup } from "./BoardSetup.tsx";

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
  const [open, setOpen] = useState(true);
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
        <b>{repo.id}</b> · {session ? "Crew" : "Observed"} · default {account || "—"}
        <span>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <>
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
          {session ? (
            <Seats session={session} config={config} defaultAccount={account} />
          ) : (
            <Observed repo={repo} config={config} onConvert={onConvert} />
          )}
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
function SeatEditor({
  seat,
  config,
  defaultAccount,
  onCancel,
  onSave,
}: {
  seat?: SeatInput;
  config: ConfigView;
  defaultAccount: string;
  onCancel: () => void;
  onSave: (seat: SeatInput) => void;
}) {
  const firstRole = config.crew?.roles?.[0]?.name ?? "";
  const [form, setForm] = useState<SeatInput>(
    seat ?? { id: "", role: firstRole, accountId: defaultAccount, model: "", area: [] },
  );
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
  return (
    <form
      className="repo-seat-editor"
      aria-label={seat ? `Edit ${seat.id}` : "Add seat"}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (form.id && form.role && form.accountId && form.model) onSave(form);
      }}
    >
      <label>
        Call sign
        <input
          value={form.id}
          disabled={!!seat}
          onChange={(e) => setForm({ ...form, id: e.target.value })}
        />
      </label>
      <label>
        Role
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {config.crew?.roles?.map((role) => (
            <option key={role.name} value={role.name}>
              {roleLabel(config, role.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Account
        <select
          value={form.accountId}
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
      </label>
      <label>
        Model
        <select
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value, effort: undefined })}
          disabled={models.length === 0}
        >
          <option value="">No discovered models</option>
          {models.map((model) => (
            <option key={model.model} value={model.model}>
              {model.model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select
          value={form.effort ?? ""}
          onChange={(e) => setForm({ ...form, effort: e.target.value || undefined })}
        >
          <option value="">CLI default</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" checked readOnly /> Enabled
      </label>
      <button className="primary sm" type="submit">
        Save seat
      </button>
      <button className="sm" type="button" onClick={onCancel}>
        Cancel
      </button>
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
  const base =
    changes?.sessions.find((item) => item.id === session.id)?.seats ?? session.seats.map(inputOf);
  const save = async (seats: SeatInput[]) => {
    try {
      const result = await apiPost<{ backup: string }>(ACTIONS.crewSeats(session.id), {
        base,
        seats,
      });
      toast(`Seats saved. Backup: ${result.backup}.`);
      setEditing(null);
      setAdding(false);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crewChanges.path);
    } catch (error) {
      toast(errorText(error));
    }
  };
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
                  onClick={() => {
                    setEditing(seat.id);
                    setAdding(false);
                  }}
                >
                  Edit
                </button>{" "}
                <button
                  type="button"
                  className="sm"
                  onClick={() => void save(base.filter((item) => item.id !== seat.id))}
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
          config={config}
          defaultAccount={defaultAccount}
          onCancel={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSave={(seat) =>
            void save(
              editing ? base.map((item) => (item.id === editing ? seat : item)) : [...base, seat],
            )
          }
        />
      )}
      {!adding && !editing && (
        <button type="button" className="sm" onClick={() => setAdding(true)}>
          + Add seat to this repo
        </button>
      )}
    </section>
  );
}

/** Four explicit steps keep all read-only checks ahead of config and crew writes. */
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const repoOk =
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github) &&
    Number.isInteger(Number(project)) &&
    Number(project) > 0;
  const checkoutOk = source.trim() !== "" && branch.trim() !== "";
  const resetChecks = () => {
    latest.current++;
    setPreview(null);
    setError(null);
  };
  const checks = async () => {
    if (!repoOk || !checkoutOk || busy) return;
    const mine = ++latest.current;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const found = await apiPost<RepoPreview>(ACTIONS.previewRepo, {
        github,
        project: Number(project),
      });
      if (mine !== latest.current) return;
      await apiPost(ACTIONS.previewCheckout, {
        github,
        source: source.trim(),
        branch: branch.trim(),
        defaultBranch: found.defaultBranch,
      });
      if (mine === latest.current) {
        setPreview(found);
        setStep(4);
      }
    } catch (err) {
      if (mine === latest.current) setError(errorText(err));
    } finally {
      if (mine === latest.current) setBusy(false);
    }
  };
  const submit = async () => {
    if (!preview || !account || busy) return;
    setBusy(true);
    setError(null);
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
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="repo-stepper"
      aria-label={repo ? `Convert ${repo.id} to crew repo` : "Add repo"}
    >
      <div className="stepper">
        <span className={step >= 1 ? "on" : ""}>1 repo</span>
        <span className={step >= 2 ? "on" : ""}>2 checkout folder</span>
        <span className={step >= 3 ? "on" : ""}>3 live checks</span>
        <span className={step >= 4 ? "on" : ""}>4 mode and account</span>
      </div>
      {step === 1 && (
        <>
          <label>
            GitHub repo
            <input
              value={github}
              disabled={!!repo}
              placeholder="owner/name"
              onChange={(e) => {
                setGithub(e.target.value);
                resetChecks();
              }}
            />
          </label>
          <label>
            Project number
            <input
              inputMode="numeric"
              disabled={!!repo}
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                resetChecks();
              }}
            />
          </label>
          {!repo && (
            <label>
              Repo id
              <input value={id} onChange={(e) => setId(e.target.value)} />
            </label>
          )}
          <button
            type="button"
            className="primary sm"
            disabled={!repoOk || (!repo && !/^[a-z][a-z0-9-]{0,30}$/.test(id.trim()))}
            onClick={() => setStep(2)}
          >
            Next: checkout
          </button>
        </>
      )}
      {step === 2 && (
        <>
          <label>
            Checkout folder
            <input
              value={source}
              placeholder="/absolute/path/to/clone"
              onChange={(e) => {
                setSource(e.target.value);
                resetChecks();
              }}
            />
          </label>
          <label>
            Branch
            <input
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                resetChecks();
              }}
            />
          </label>
          <button type="button" className="sm" onClick={() => setStep(1)}>
            Back
          </button>
          <button
            type="button"
            className="primary sm"
            disabled={!checkoutOk}
            onClick={() => setStep(3)}
          >
            Next: live checks
          </button>
        </>
      )}
      {step === 3 && (
        <>
          <p className="note">
            Checks verify the local git repository, origin, branch, GitHub access, CI workflow and
            Project board before anything is written.
          </p>
          <button type="button" className="sm" onClick={() => setStep(2)}>
            Back
          </button>
          <button
            type="button"
            className="primary sm"
            disabled={busy}
            onClick={() => void checks()}
          >
            {busy ? "Checking…" : "Run live checks"}
          </button>
        </>
      )}
      {step === 4 && preview && (
        <>
          <p className="note">{preview.projectTitle || github} · Project board verified.</p>
          <label>
            Mode
            <select
              value={mode}
              disabled={!!repo}
              onChange={(e) => setMode(e.target.value as "observed" | "crew")}
            >
              <option value="observed">Observed</option>
              <option value="crew">Crew</option>
            </select>
          </label>
          <label>
            Default account
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              {config.accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="sm" onClick={() => setStep(3)}>
            Back
          </button>
          <button
            type="button"
            className="primary sm"
            disabled={busy || !account}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : repo ? "Convert to crew repo" : "Add repo"}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="crit-t">
          {error}
        </p>
      )}
      <button type="button" className="sm" onClick={close}>
        Cancel
      </button>
    </section>
  );
}
