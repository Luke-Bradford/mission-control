import {
  errorText,
  GITHUB_POINTS_PER_HOUR,
  type GithubBudget,
  hudColumnOf,
  missingColumns,
  type NewRepo,
  type RepoPreview,
  type RepoProfile,
  type RepoView,
  TICKET_STATES,
  type TicketState,
} from "@mc/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { githubHref } from "../links.ts";
import { toast } from "../shell/Toast.tsx";
import { BoardSetup } from "./BoardSetup.tsx";

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const num = (n: number): string => Math.ceil(n).toLocaleString("en-GB");
const lacks = (columns: string[]): string =>
  columns.length === 0 ? "Has every column" : `Lacks: ${columns.join(", ")}`;

const budgetLine = (b: GithubBudget): string =>
  `GitHub: ≈${num(b.totalPerHour)} requests/hour at most (board ${num(b.boardPerHour)} · PR sweep ${num(b.sweepPerHour)} · flow ${num(b.flowPerHour)}) of ${GITHUB_POINTS_PER_HOUR.toLocaleString("en-GB")}`;

/** Setup › Repos (#26 A8): how the configured repos' boards differ, and the add-a-repo form. */
export function Repos() {
  const { data: profiles, error } = useResource<RepoProfile[]>(RESOURCES.repoProfiles);
  // The profiles ride the `boards` topic; the repo list rides `config`. A config change (a repo
  // added or edited) must refresh the cards too, so the list is a trigger for the profiles.
  const repos = useResource<RepoView[]>(RESOURCES.repos).data;
  const seen = useRef(repos);
  useEffect(() => {
    if (seen.current === repos) return;
    // The first answer is the load itself; the profiles are already on their way.
    const first = seen.current === undefined;
    seen.current = repos;
    if (!first) hub.refetch(RESOURCES.repoProfiles.path);
  }, [repos]);

  return (
    <>
      <p className="note wide">
        How each repo's GitHub project differs: which Status values it uses, which board columns
        nothing reaches, where priority comes from, and what polling it costs.
      </p>
      {!profiles ? (
        <p className="muted s">
          {error ? `Could not load the repos: ${error.message}` : "Loading…"}
        </p>
      ) : (
        profiles.map((p) => <ProfileCard key={p.id} profile={p} />)
      )}
      <AddRepo />
    </>
  );
}

function ProfileCard({ profile: p }: { profile: RepoProfile }) {
  const owner = p.github.split("/")[0] ?? "";
  const href = githubHref(
    p.projectUrl ?? `https://github.com/users/${owner}/projects/${p.project}`,
  );
  const project = `project ${p.project}`;
  return (
    <Panel
      title={p.id}
      sub={
        <>
          {p.github} ·{" "}
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {project}
            </a>
          ) : (
            project
          )}
        </>
      }
    >
      <div className="pb">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Status on GitHub</th>
                <th>Column (state)</th>
                <th className="r">Items</th>
              </tr>
            </thead>
            <tbody>
              {p.statuses.map((s) => (
                <tr key={s.status}>
                  <td>{s.status}</td>
                  <td>{`${s.column} (${s.state})`}</td>
                  <td className="r num">{s.items}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="s">{lacks(p.missingColumns)}</p>
        <p className="s">
          {`Priority: Project field (${p.priority.field}) · p0–p3 labels (${p.priority.label}) · none (${p.priority.none})`}
        </p>
        <p className="s">{budgetLine(p.budget)}</p>
        <p className="s">
          {p.loops.length === 0 ? "No loop works this repo." : `Loops: ${p.loops.join(", ")}`}
        </p>
        <BoardSetup repoId={p.id} github={p.github} />
      </div>
    </Panel>
  );
}

const PRIORITY_READ: Record<RepoPreview["priority"], string> = {
  field: "Priority: read from the project's Priority field.",
  labels: "Priority: read from p0–p3 labels (the project has no Priority field).",
  none: "Priority: none found (no Priority field and no p0–p3 labels).",
};

function AddRepo() {
  const [github, setGithub] = useState("");
  const [project, setProject] = useState("");
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const number = Number(project);
  const valid = GITHUB_REPO.test(github) && Number.isInteger(number) && number >= 1;

  // The latest preview request; an older one answering after it is ignored.
  const latest = useRef(0);

  // Editing what was previewed discards the preview, and any request still out: the proposal
  // belongs to that repo.
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    latest.current++;
    setBusy(false);
    setPreview(null);
    setError(null);
  };

  async function onPreview(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    const mine = ++latest.current;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const got = await apiPost<RepoPreview>(ACTIONS.previewRepo, { github, project: number });
      if (mine === latest.current) setPreview(got);
    } catch (err) {
      if (mine === latest.current) setError(errorText(err));
    } finally {
      if (mine === latest.current) setBusy(false);
    }
  }

  return (
    <Panel title="Add a repo" sub="reads GitHub, then writes config.yaml" className="wide">
      <div className="pb">
        <form className="frow" onSubmit={(e) => void onPreview(e)}>
          <label className="s fg2">
            GitHub repo
            <input
              value={github}
              placeholder="owner/name"
              onChange={(e) => edit(setGithub)(e.target.value)}
            />
          </label>
          <label className="s fg2">
            Project number
            <input
              inputMode="numeric"
              value={project}
              onChange={(e) => edit(setProject)(e.target.value)}
            />
          </label>
          <button type="submit" disabled={!valid || busy}>
            Preview
          </button>
        </form>
        {error !== null && !preview && (
          <p role="alert" className="crit-t s">
            {error}
          </p>
        )}
        {preview && (
          <PreviewResult
            key={`${preview.github}#${preview.project}`}
            preview={preview}
            onAdded={() => {
              setPreview(null);
              setGithub("");
              setProject("");
            }}
          />
        )}
      </div>
    </Panel>
  );
}

function PreviewResult({ preview, onAdded }: { preview: RepoPreview; onAdded: () => void }) {
  const [statusMap, setStatusMap] = useState<Record<string, TicketState>>(
    preview.proposedStatusMap,
  );
  const [id, setId] = useState(preview.github.split("/")[1] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statuses = preview.statusOptions;
  const repoId = id.trim();
  async function add() {
    setBusy(true);
    setError(null);
    const body: NewRepo = {
      id: repoId,
      github: preview.github,
      project: preview.project,
      statusMap,
    };
    try {
      const done = await apiPost<{ backup: string }>(ACTIONS.addRepo, body);
      toast(`Added ${repoId}. Backup: ${done.backup}.`);
      onAdded();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="preview">
      <p className="s">{`${preview.projectTitle} · ${preview.items} item${preview.items === 1 ? "" : "s"}`}</p>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Status on GitHub</th>
              <th>State</th>
              <th>Column</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => {
              const state = statusMap[s] ?? "planned";
              return (
                <tr key={s}>
                  <td>{s}</td>
                  <td>
                    <select
                      aria-label={`State of ${s}`}
                      value={state}
                      onChange={(e) =>
                        setStatusMap({ ...statusMap, [s]: e.target.value as TicketState })
                      }
                    >
                      {TICKET_STATES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{hudColumnOf({ status: s, state, closed: false })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="s">{lacks(missingColumns(statusMap))}</p>
      <p className="s">{PRIORITY_READ[preview.priority]}</p>
      <p className="s">
        {`GitHub: ${num(preview.budgetNow)} → ${num(preview.budgetNow + preview.budget.totalPerHour)} requests/hour of ${GITHUB_POINTS_PER_HOUR.toLocaleString("en-GB")}`}
      </p>
      <p className="s">Loops: none yet — a loop is added in config.yaml.</p>
      <label className="s fg2">
        Repo id
        <input value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      <p className="note">
        Mission Control adds this repo to config.yaml and keeps a backup of the current file beside
        it. It starts reading the project on the next poll. Nothing is written to GitHub.
      </p>
      {error !== null && (
        <p role="alert" className="crit-t s">
          {error}
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || repoId === ""}
        onClick={() => void add()}
      >
        {`Add ${repoId}`}
      </button>
    </div>
  );
}
