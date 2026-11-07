import type { ConfigView, HealthRow } from "@mc/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import { apiPost } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
} from "../components/formSupport.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";

type Feed = {
  kind: "chat" | "channel";
  id: string;
  teamId?: string;
  name: string;
  repoId: string;
  lane: "work" | "personal";
};
interface TeamsStatus {
  enabled: boolean;
  selected: Feed[];
  note: string;
  retryAt: number | null;
}

/** Selection uses Graph IDs from local configuration; the server offers no feed directory. */
export function TeamsSources({ config }: { config: ConfigView | undefined }) {
  const result = useResource<TeamsStatus>(RESOURCES.teams);
  const health = useResource<HealthRow[]>(RESOURCES.health);
  // Collector status writes emit no SSE topic; keep status current while Sources is open.
  useEffect(() => {
    const timer = setInterval(() => {
      hub.refetch(RESOURCES.teams.path);
      hub.refetch(RESOURCES.health.path);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const [selection, setSelection] = useState<Feed[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Feed["kind"]>("chat");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [focusKey, setFocusKey] = useState(0);
  const base = useId();
  const ids = {
    kind: `${base}-kind`,
    name: `${base}-name`,
    id: `${base}-id`,
    teamId: `${base}-team`,
    repo: `${base}-repo`,
  };
  const tz = useTz();
  const now = useNow();
  const status = result.data;
  const selected = selection ?? status?.selected.filter((s) => s.lane === "work") ?? [];
  const poll = health.data?.find((h) => h.collector === "teams");
  // A failed refresh keeps the last good status and selection; only no data at all is bare.
  if (!status && result.error)
    return <p role="alert">Could not load Teams: {result.error.message}</p>;
  if (!status) return <p role="status">Loading Teams…</p>;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(RESOURCES.teamsSelection.path, { selected });
      setSelection(null);
      hub.refetch(RESOURCES.teams.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "server unreachable");
    } finally {
      setBusy(false);
    }
  };
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const feed: Feed = {
      kind,
      id: String(data.get("id")).trim(),
      name: String(data.get("name")).trim(),
      repoId: String(data.get("repoId")),
      lane: "work",
      ...(kind === "channel" ? { teamId: String(data.get("teamId")).trim() } : {}),
    };
    const found: FieldIssue[] = [];
    if (!feed.name) found.push({ id: ids.name, message: "Feed name is required." });
    if (!feed.id) found.push({ id: ids.id, message: "Feed ID is required." });
    if (kind === "channel" && !feed.teamId)
      found.push({ id: ids.teamId, message: "Team ID is required for a channel." });
    if (!feed.repoId) found.push({ id: ids.repo, message: "Work repo is required." });
    if (
      found.length === 0 &&
      selected.some((s) => s.kind === feed.kind && s.id === feed.id && s.teamId === feed.teamId)
    )
      found.push({ id: ids.id, message: `Feed ID ${feed.id} is already selected.` });
    setIssues(found);
    if (found.length > 0) {
      setFocusKey((key) => key + 1);
      return;
    }
    setSelection([...selected, feed]);
    form.reset();
  };
  return (
    <div className="teams-sources fform fform-640">
      {result.error && (
        <p role="alert" className="crit-t s">
          Could not load Teams: {result.error.message}. Showing the last status; your selection is
          kept.
        </p>
      )}
      <div className="fgroup">
        <p className="s" role="status">
          {status.enabled ? "Polling enabled" : "Off"} · <span>{status.note}</span>
        </p>
        {status.note.includes("not permitted with this login") && (
          <p className="note">
            Configure login and app consent outside Mission Control for Chat.Read and
            ChannelMessage.Read.All, then update sources.teams.token_command in local config to
            resume polling.
          </p>
        )}
        <p className="s">
          last successful poll{" "}
          {poll?.lastOkAt == null ? "never" : tz ? rel(poll.lastOkAt, now, tz) : "—"}
        </p>
        {poll && !poll.ok && <p className="crit-t s">{poll.error}</p>}
        {health.error && (
          <p className="crit-t s">Could not load polling health: {health.error.message}</p>
        )}
        {status.retryAt !== null && (
          <p className="note">Retry {tz ? rel(status.retryAt, now, tz) : "—"}</p>
        )}
      </div>
      <div className="fgroup">
        {selected.length === 0 && <p className="note">No selected work feeds.</p>}
        <ul className="tlist" aria-label="Selected Teams feeds">
          {selected.map((feed, index) => (
            <li className="row" key={`${feed.kind}:${feed.teamId ?? ""}:${feed.id}`}>
              <span>{feed.name}</span>
              <span className="muted">
                {feed.kind} · {feed.repoId}
              </span>
              <button
                type="button"
                aria-label={`Remove ${feed.name}`}
                disabled={busy}
                onClick={() => setSelection(selected.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <form className="fform" noValidate onSubmit={add}>
        <fieldset className="fgroup">
          <legend>Add a feed</legend>
          <p className="note">
            Work only. Add chat or channel IDs from your local configuration; access is configured
            outside the app.
          </p>
          <div className="fpair">
            <div className="ffield">
              <label htmlFor={ids.kind}>Feed kind</label>
              <select
                id={ids.kind}
                value={kind}
                onChange={(e) => setKind(e.target.value as Feed["kind"])}
              >
                <option value="chat">Chat</option>
                <option value="channel">Channel</option>
              </select>
            </div>
            <div className="ffield">
              <label htmlFor={ids.repo}>Work repo</label>
              <select {...fieldProps(ids.repo, issueOf(issues, ids.repo))} name="repoId">
                {config?.repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.id}
                  </option>
                ))}
              </select>
              <FieldError id={ids.repo} error={issueOf(issues, ids.repo)} />
            </div>
          </div>
          <div className="ffield">
            <label htmlFor={ids.name}>Feed name</label>
            <input
              {...fieldProps(ids.name, issueOf(issues, ids.name))}
              name="name"
              maxLength={200}
            />
            <FieldError id={ids.name} error={issueOf(issues, ids.name)} />
          </div>
          <div className="ffield">
            <label htmlFor={ids.id}>Feed ID</label>
            <input {...fieldProps(ids.id, issueOf(issues, ids.id))} name="id" maxLength={200} />
            <FieldError id={ids.id} error={issueOf(issues, ids.id)} />
          </div>
          {kind === "channel" && (
            <div className="ffield">
              <label htmlFor={ids.teamId}>Team ID</label>
              <input
                {...fieldProps(ids.teamId, issueOf(issues, ids.teamId))}
                name="teamId"
                maxLength={200}
              />
              <FieldError id={ids.teamId} error={issueOf(issues, ids.teamId)} />
            </div>
          )}
        </fieldset>
        <ErrorSummary
          title="Fix before adding"
          issues={issues}
          message={null}
          focusKey={focusKey}
        />
        <div className="fact">
          <button type="submit" disabled={busy || selected.length >= 50 || !config?.repos.length}>
            Add feed
          </button>
        </div>
      </form>
      <div className="fact">
        <button
          type="button"
          className="primary"
          disabled={busy || selection === null}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save Teams selection"}
        </button>
      </div>
      {error && (
        <p role="alert" className="crit-t s">
          {error}
        </p>
      )}
    </div>
  );
}
