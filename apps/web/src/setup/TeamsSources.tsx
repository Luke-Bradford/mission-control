import type { ConfigView, HealthRow } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
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
  const [selection, setSelection] = useState<Feed[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Feed["kind"]>("chat");
  const tz = useTz();
  const now = useNow();
  const status = result.data;
  const selected = selection ?? status?.selected.filter((s) => s.lane === "work") ?? [];
  const poll = health.data?.find((h) => h.collector === "teams");
  if (result.error) return <p role="alert">Could not load Teams: {result.error.message}</p>;
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
  return (
    <div className="teams-sources">
      <p className="s" role="status">
        {status.enabled ? "Polling enabled" : "Off"} · <span>{status.note}</span>
      </p>
      {status.note.includes("not permitted with this login") && (
        <p className="note">
          Configure login and app consent outside Mission Control for Chat.Read and
          ChannelMessage.Read.All, then update sources.teams.token_command in local config to resume
          polling.
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
              disabled={busy}
              onClick={() => setSelection(selected.filter((_, i) => i !== index))}
            >
              Remove {feed.name}
            </button>
          </li>
        ))}
      </ul>
      <p className="note">
        Work only. Add chat or channel IDs from your local configuration; access is configured
        outside the app.
      </p>
      <form
        className="teams-selection"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const feed: Feed = {
            kind,
            id: String(data.get("id")).trim(),
            name: String(data.get("name")).trim(),
            repoId: String(data.get("repoId")),
            lane: "work",
            ...(kind === "channel" ? { teamId: String(data.get("teamId")).trim() } : {}),
          };
          if (!feed.id || !feed.name || !feed.repoId || (kind === "channel" && !feed.teamId))
            return;
          if (
            selected.some(
              (s) => s.kind === feed.kind && s.id === feed.id && s.teamId === feed.teamId,
            )
          )
            return;
          setSelection([...selected, feed]);
          event.currentTarget.reset();
        }}
      >
        <label>
          Feed kind
          <select value={kind} onChange={(e) => setKind(e.target.value as Feed["kind"])}>
            <option value="chat">Chat</option>
            <option value="channel">Channel</option>
          </select>
        </label>
        <label>
          Feed name
          <input name="name" required maxLength={200} />
        </label>
        <label>
          Feed ID
          <input name="id" required maxLength={200} />
        </label>
        {kind === "channel" && (
          <label>
            Team ID
            <input name="teamId" required maxLength={200} />
          </label>
        )}
        <label>
          Work repo
          <select name="repoId" required>
            {config?.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.id}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || selected.length >= 50 || !config?.repos.length}>
          Add feed
        </button>
      </form>
      <button type="button" disabled={busy || selection === null} onClick={() => void save()}>
        {busy ? "Saving…" : "Save Teams selection"}
      </button>
      {error && (
        <p role="alert" className="crit-t s">
          {error}
        </p>
      )}
    </div>
  );
}
