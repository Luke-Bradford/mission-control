import { type ConfigView, CREW_EFFORTS, errorText, type SeatInput } from "@mc/core";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
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
  const [adding, setAdding] = useState(false);
  return (
    <section className="setup-repos" aria-label="Repos and seats">
      <div className="setup-repos-head">
        <span className="cap">Repos &amp; seats</span>
        <button type="button" className="primary sm" onClick={() => setAdding((open) => !open)}>
          + Add repo
        </button>
      </div>
      {adding && <AddRepo close={() => setAdding(false)} />}
      {config.repos.map((repo) => (
        <RepoCard key={repo.id} repo={repo} config={config} />
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

function RepoCard({ repo, config }: { repo: Repo; config: ConfigView }) {
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
          {session ? (
            <Seats session={session} config={config} defaultAccount={account} />
          ) : (
            <Observed repo={repo} config={config} />
          )}
        </>
      )}
    </article>
  );
}

function Observed({ repo, config }: { repo: Repo; config: ConfigView }) {
  const loops = config.loops.filter((loop) => loop.repoId === repo.id);
  return (
    <div className="repo-observed">
      <p className="note">
        <b>External loop, read-only:</b>{" "}
        {loops.length
          ? loops.map((loop) => `${loop.kind} · ${loop.launchdLabel}`).join(", ")
          : "No external loop configured."}
      </p>
      <button type="button" className="sm" disabled title="Create a crew checkout from Add repo">
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
    seat ?? { id: "", role: firstRole, accountId: defaultAccount, model: "gpt-5.6-sol", area: [] },
  );
  const models = useMemo(
    () => [
      ...new Set([
        form.model,
        ...(config.crew?.sessions.flatMap((s) =>
          s.seats.filter((x) => x.accountId === form.accountId).map((x) => x.model),
        ) ?? []),
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "sonnet",
      ]),
    ],
    [form.model, form.accountId, config],
  );
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
          onChange={(e) => setForm({ ...form, accountId: e.target.value })}
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
        <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {models.map((model) => (
            <option key={model}>{model}</option>
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
          {CREW_EFFORTS.map((effort) => (
            <option key={effort}>{effort}</option>
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

/** Four explicit steps keep the live repository checks before any configuration write. */
function AddRepo({ close }: { close: () => void }) {
  const [github, setGithub] = useState("");
  const [project, setProject] = useState("");
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github) && Number(project) > 0;
  return (
    <form
      className="repo-stepper"
      aria-label="Add repo"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setError(null);
        try {
          await apiPost(ACTIONS.previewRepo, { github, project: Number(project) });
          setStep(4);
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <div className="stepper">
        <span className={step >= 1 ? "on" : ""}>1 repo</span>
        <span className={step >= 2 ? "on" : ""}>2 checkout folder</span>
        <span className={step >= 3 ? "on" : ""}>3 live checks</span>
        <span className={step >= 4 ? "on" : ""}>4 mode and account</span>
      </div>
      <label>
        GitHub repo
        <input
          value={github}
          placeholder="owner/name"
          onChange={(e) => setGithub(e.target.value)}
        />
      </label>
      <label>
        Project number
        <input inputMode="numeric" value={project} onChange={(e) => setProject(e.target.value)} />
      </label>
      <p className="note">
        Live checks verify the git repo, remote, default branch, GitHub access, CI workflow and
        Project board before it is added.
      </p>
      {error && (
        <p role="alert" className="crit-t">
          {error}
        </p>
      )}
      <button type="submit" className="primary sm" disabled={!valid}>
        Run live checks
      </button>
      <button type="button" className="sm" onClick={close}>
        Cancel
      </button>
    </form>
  );
}
