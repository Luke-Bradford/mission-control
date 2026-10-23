import type { ItemDiscussion as Discussion } from "@mc/core";
import { useState } from "react";
import { hub, RESOURCES, useResource } from "../data.ts";
import { askFlight } from "./answer.ts";

export function ItemDiscussion(p: { itemKey: string; live: boolean; title?: string }) {
  return <DiscussionBody key={p.itemKey} {...p} />;
}

function DiscussionBody({
  itemKey,
  live,
  title,
}: {
  itemKey: string;
  live: boolean;
  title?: string;
}) {
  const current = useResource<Discussion>(RESOURCES.discussion(itemKey));
  const resource = current.data ? RESOURCES.discussion(itemKey, current.data.id) : null;
  const history = useResource<Discussion>(resource);
  const discussion = history.data ?? current.data;
  const loadError = history.error ?? (!discussion ? current.error : null);
  const refresh = () => {
    hub.refetch(RESOURCES.discussion(itemKey).path);
    if (resource) hub.refetch(resource.path);
  };
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ text: string; version: string; id: string } | null>(null);
  const send = async () => {
    const body = text.trim();
    if (!body || !discussion || !live || pending) return;
    const message =
      retry?.text === body && retry.version === discussion.version
        ? retry
        : { text: body, version: discussion.version, id: crypto.randomUUID() };
    setRetry(message);
    setPending(true);
    setError(null);
    try {
      await askFlight(itemKey, message.version, message.id, message.text);
      setText("");
      setRetry(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "server unreachable");
    } finally {
      setPending(false);
      if (resource) hub.refetch(resource.path);
    }
  };
  return (
    <>
      <div
        className="dmsgs"
        id="dsMsgs"
        role="log"
        aria-label="Item discussion"
        aria-busy={history.loading || pending}
      >
        {!discussion && !loadError && <p className="note">Loading discussion…</p>}
        {discussion?.messages.length === 0 && <p className="note">No messages yet.</p>}
        {discussion?.messages
          .filter((m) => m.itemKey === itemKey && m.correlationId === discussion?.id)
          .map((m) => (
            <div className={`dmsg ${m.role === "operator" ? "you" : "flight"}`} key={m.id}>
              <span className="who">{m.role === "operator" ? "You" : "FLIGHT"}</span>
              <div className="txt">{m.text}</div>
            </div>
          ))}
        {loadError && (
          <p className="note err" role="alert">
            {loadError.message}
          </p>
        )}
        <button type="button" className="sm" onClick={refresh}>
          Refresh discussion
        </button>
      </div>
      <form
        className="composer"
        id="dsDiscussionForm"
        onSubmit={(ev) => {
          ev.preventDefault();
          void send();
        }}
      >
        <input
          aria-label="Ask FLIGHT about this"
          placeholder="Ask FLIGHT about this…"
          autoComplete="off"
          maxLength={4000}
          value={text}
          disabled={!live || pending}
          title={title}
          onChange={(ev) => setText(ev.target.value)}
        />
        <button
          type="submit"
          className="primary"
          disabled={!live || !discussion || pending || !text.trim()}
          title={title}
        >
          Ask FLIGHT
        </button>
        {pending && (
          <span className="note" role="status">
            Sending…
          </span>
        )}
        {error && (
          <p className="note err" role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
