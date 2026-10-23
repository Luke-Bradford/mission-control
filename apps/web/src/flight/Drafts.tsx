import { MC_TEXT_MAX, type ReplyDraft } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import { toast } from "../shell/Toast.tsx";

export const NO_DRAFTS = "No drafts to send.";
export const postedText = (where: string): string =>
  `Posted on ${where} as you. Clicking Post was your approval.`;

function DraftRow({ draft, finish }: { draft: ReplyDraft; finish: (draft: ReplyDraft) => void }) {
  const [text, setText] = useState(draft.text);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = draft.state !== "pending";
  const where = draft.where ?? draft.target;
  const via = draft.via ?? "GitHub";
  const act = async (action: "post" | "copy" | "discard") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "copy") {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          toast("Copy was blocked here; select the text and copy it.");
          return;
        }
        toast("Copied. Paste it into Teams.");
      } else {
        await apiPost(
          (action === "post" ? ACTIONS.postDraft : ACTIONS.discardDraft)(String(draft.id)),
          action === "post" ? { text } : {},
        );
        if (action === "post") toast(postedText(where));
      }
      finish({
        ...draft,
        text,
        state: action === "post" ? "posted" : action === "copy" ? "copied" : "discarded",
      });
      hub.refetchTopic("flight");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`pb draft-row${done ? " acked" : ""}`}>
      <div className="row">
        <b>To {draft.to ?? draft.target}</b>
        <span className="chipref">
          {via} · {where}
        </span>
        {done && (
          <Pill tone="plain">
            {draft.state === "posted"
              ? "Posted"
              : draft.state === "copied"
                ? "Copied"
                : "Discarded"}
          </Pill>
        )}
      </div>
      <p className="note">
        {draft.context ?? `${draft.kind === "pr" ? "PR" : "Issue"} ${draft.target}`}
      </p>
      {editing && !done ? (
        <textarea
          aria-label={`Draft for ${draft.target}`}
          maxLength={MC_TEXT_MAX}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <p className="pre">{done ? draft.text : text}</p>
      )}
      {!done && (
        <div className="row">
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => void act(via === "Teams" ? "copy" : "post")}
          >
            {via === "Teams" ? "Copy for Teams" : "Post on GitHub"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(!editing);
              if (!editing) toast("Opens the draft so you can change it first.");
            }}
          >
            {editing ? "Done editing" : "Edit"}
          </button>
          <button type="button" disabled={busy} onClick={() => void act("discard")}>
            Discard
          </button>
        </div>
      )}
      {!done && error && (
        <p role="alert" className="note err">
          {error}
        </p>
      )}
    </div>
  );
}

export function Drafts() {
  const pending = useResource<ReplyDraft[]>(RESOURCES.drafts);
  const history = useResource<ReplyDraft[]>(RESOURCES.draftHistory);
  const [finished, setFinished] = useState<ReplyDraft[]>([]);
  const rows = new Map<number, ReplyDraft>();
  for (const draft of [...(pending.data ?? []), ...finished, ...(history.data ?? [])])
    rows.set(draft.id, draft);
  const error = pending.error ?? history.error;
  return (
    <div>
      {error && (
        <p className="pb note err" role="alert">
          {error.message}
        </p>
      )}
      {pending.data === undefined || history.data === undefined ? (
        !error && <p className="pb note">—</p>
      ) : rows.size === 0 ? (
        <p className="pb note">{NO_DRAFTS}</p>
      ) : null}
      {[...rows.values()].map((draft) => (
        <DraftRow
          key={draft.id}
          draft={draft}
          finish={(done) => setFinished((old) => [...old.filter((d) => d.id !== done.id), done])}
        />
      ))}
    </div>
  );
}
