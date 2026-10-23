import { MC_TEXT_MAX, type ReplyDraft } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { toast } from "../shell/Toast.tsx";

export const NO_DRAFTS = "No drafts to send.";
export const postedText = (where: string): string =>
  `Posted on ${where} as you. Clicking Post was your approval.`;

function DraftRow({ draft }: { draft: ReplyDraft }) {
  const [text, setText] = useState(draft.text);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (post: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(
        (post ? ACTIONS.postDraft : ACTIONS.discardDraft)(String(draft.id)),
        post ? { text } : {},
      );
      if (post) toast(postedText(draft.target));
      hub.refetchTopic("flight");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pb">
      <p>
        <b>{draft.target}</b> · {draft.kind === "pr" ? "PR" : "Issue"}
      </p>
      {editing ? (
        <textarea
          aria-label={`Draft for ${draft.target}`}
          maxLength={MC_TEXT_MAX}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <p className="pre">{text}</p>
      )}
      <div className="row">
        <button type="button" disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? "Done editing" : "Edit"}
        </button>
        <button type="button" disabled={busy || !text.trim()} onClick={() => void act(true)}>
          Post on GitHub
        </button>
        <button type="button" disabled={busy} onClick={() => void act(false)}>
          Discard
        </button>
      </div>
      {error && (
        <p role="alert" className="note err">
          {error}
        </p>
      )}
    </div>
  );
}

export function Drafts() {
  const { data, error } = useResource<ReplyDraft[]>(RESOURCES.drafts);
  if (error)
    return (
      <p className="pb note err" role="alert">
        {error.message}
      </p>
    );
  if (data === undefined) return <p className="pb note">—</p>;
  return data.length === 0 ? (
    <p className="pb note">{NO_DRAFTS}</p>
  ) : (
    <div>
      {data.map((draft) => (
        <DraftRow key={draft.id} draft={draft} />
      ))}
    </div>
  );
}
