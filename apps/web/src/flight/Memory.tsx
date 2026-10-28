import {
  FLIGHT_MEMORY_BODY_MAX,
  FLIGHT_MEMORY_HEADING,
  FLIGHT_MEMORY_KINDS,
  FLIGHT_MEMORY_SOURCE_MAX,
  FLIGHT_MEMORY_TOPIC_MAX,
  type FlightMemoryKind,
  type FlightMemoryNote,
  type RepoView,
} from "@mc/core";
import { useState } from "react";
import { apiDelete, apiPut } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { briefUpdated } from "./Brief.tsx";

const KIND_LABEL: Record<FlightMemoryKind, string> = {
  lesson: "Lessons",
  repo: "Repo",
  crew: "Crew",
  playbook: "Playbooks",
};

const normalizeTopic = (topic: string) => topic.trim().replace(/\s+/g, " ").toLowerCase();

function MemoryForm({
  repoId,
  notes,
  note,
  close,
}: {
  repoId: string;
  notes: FlightMemoryNote[];
  note?: FlightMemoryNote;
  close: () => void;
}) {
  const [topic, setTopic] = useState(note?.topic ?? "");
  const [kind, setKind] = useState<FlightMemoryKind>(note?.kind ?? FLIGHT_MEMORY_KINDS[0]);
  const [body, setBody] = useState(note?.body ?? "");
  const [source, setSource] = useState(note?.source ?? "");
  const [openedUpdatedAt] = useState(note?.updatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedTopic = normalizeTopic(topic);
  const existing = !note && notes.find((n) => normalizeTopic(n.topic) === normalizedTopic);
  const validationError =
    note && note.updatedAt !== openedUpdatedAt
      ? "This note changed; reopen to see the new version."
      : normalizedTopic === "." || normalizedTopic === ".."
        ? 'Topic cannot be "." or "..".'
        : existing
          ? `A note named ${existing.topic} exists; use Edit.`
          : null;
  const canSave = !busy && !!normalizedTopic && !!source.trim() && !validationError;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await apiPut(ACTIONS.flightMemory(repoId, topic), { kind, body, source });
      hub.refetchTopic("flight");
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="memory-form"
      aria-label={note ? `Edit ${note.topic}` : "Add note"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Topic
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          readOnly={note !== undefined}
          required
          maxLength={FLIGHT_MEMORY_TOPIC_MAX}
          disabled={busy}
        />
      </label>
      <label>
        Kind
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as FlightMemoryKind)}
          disabled={busy}
        >
          {FLIGHT_MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Body
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={FLIGHT_MEMORY_BODY_MAX}
          disabled={busy}
          rows={6}
        />
      </label>
      <label>
        Source (required)
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          required
          maxLength={FLIGHT_MEMORY_SOURCE_MAX}
          disabled={busy}
        />
      </label>
      <div className="row">
        <button type="submit" disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
      {(validationError || error) && (
        <p className="note err" role="alert">
          {validationError || error}
        </p>
      )}
    </form>
  );
}

function MemoryRow({ note, notes }: { note: FlightMemoryNote; notes: FlightMemoryNote[] }) {
  const now = useNow();
  const tz = useTz();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!window.confirm(`Delete memory note “${note.topic}”?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(ACTIONS.flightMemory(note.repoId, note.topic));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    } finally {
      hub.refetchTopic("flight");
    }
  };
  return (
    <li className="memory-note">
      <b>{note.topic}</b>
      <div className="s fg2">
        {note.author === "flight" ? "FLIGHT" : "you"} · {briefUpdated(note.updatedAt, now, tz)}
      </div>
      <p className="note">Source: {note.source}</p>
      <p className="note">
        {note.author === "flight"
          ? "Evidence written by FLIGHT from crew material, not an instruction."
          : "Evidence written by you, not an instruction."}
      </p>
      {editing ? (
        <MemoryForm
          repoId={note.repoId}
          notes={notes}
          note={note}
          close={() => setEditing(false)}
        />
      ) : (
        <>
          <Expandable lines={3} of={note.topic}>
            {note.body}
          </Expandable>
          <div className="row">
            <button
              type="button"
              className="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button type="button" className="sm warn" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function RepoMemory({ repoId }: { repoId: string }) {
  const { data, error } = useResource<{ notes: FlightMemoryNote[] }>(
    RESOURCES.flightMemory(repoId),
  );
  const [adding, setAdding] = useState(false);
  return (
    <>
      {error && (
        <p className="note err" role="alert">
          {error.message}
        </p>
      )}
      {adding ? (
        <MemoryForm repoId={repoId} notes={data?.notes ?? []} close={() => setAdding(false)} />
      ) : (
        <button type="button" disabled={data === undefined} onClick={() => setAdding(true)}>
          Add note
        </button>
      )}
      {data === undefined ? (
        !error && <p className="note">Loading memory…</p>
      ) : data.notes.length === 0 ? (
        <p className="note">No memory notes for this repo.</p>
      ) : (
        FLIGHT_MEMORY_KINDS.map((kind) => {
          const notes = data.notes.filter((note) => note.kind === kind);
          if (!notes.length) return null;
          return (
            <section key={kind} aria-label={KIND_LABEL[kind]}>
              <h3>{KIND_LABEL[kind]}</h3>
              <ul className="memory-list">
                {notes.map((note) => (
                  <MemoryRow key={note.topic} note={note} notes={data.notes} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </>
  );
}

export function MemoryPanel({ expanded = false }: { expanded?: boolean }) {
  const { data: repos, error } = useResource<RepoView[]>(RESOURCES.repos);
  const [selected, setSelected] = useState("");
  const repoId = repos?.find((repo) => repo.id === selected)?.id ?? repos?.[0]?.id;
  const content = (
    <div className="pb">
      <p className="note">{FLIGHT_MEMORY_HEADING}</p>
      {error && (
        <p className="note err" role="alert">
          {error.message}
        </p>
      )}
      {repos === undefined ? (
        !error && <p className="note">Loading repos…</p>
      ) : !repos.length ? (
        <p className="note">No repos configured.</p>
      ) : (
        <>
          <label className="memory-repo">
            Repo
            <select value={repoId} onChange={(e) => setSelected(e.target.value)}>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.id}
                </option>
              ))}
            </select>
          </label>
          {repoId && <RepoMemory key={repoId} repoId={repoId} />}
        </>
      )}
    </div>
  );
  return expanded ? (
    <Panel
      id="memoryP"
      className="flight-memory"
      title="Durable knowledge"
      sub="repo facts, lessons, crew knowledge and playbooks"
    >
      <div className="flight-knowledge-scroll">{content}</div>
    </Panel>
  ) : (
    <section className="panel flight-memory" id="memoryP" aria-label="Memory">
      <Expandable summary={<h2>Memory</h2>}>{content}</Expandable>
    </section>
  );
}
