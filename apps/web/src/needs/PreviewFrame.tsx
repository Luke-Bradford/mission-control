import type { AttentionItem, DesignPreviewView, RepoId } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { useDemo } from "../demo/mode.ts";
import { useOverlay } from "../shell/overlays.ts";
import { store, useStore } from "../shell/store.ts";

/**
 * Where the hub serves a branch's built app (the server's DESIGN_PREVIEW_PORT, also the one
 * `frame-src` origin in WEB_CSP). The frame only ever shows this origin.
 */
export const PREVIEW_ORIGIN = "http://127.0.0.1:7440";

export const PREVIEW_GONE_TEXT = "That preview is gone.";

/** The preview that is open, one at a time: opening another replaces it. */
const open = store<{ view: DesignPreviewView; question: string } | null>(null);

export function openPreview(view: DesignPreviewView, question: string): void {
  open.set({ view, question });
}

export function closePreview(): void {
  open.set(null);
}

/**
 * What the hub says of a stored build. Builds are keyed by ticket number within the hub's own repo,
 * so `repoId` is what ties one to an item. A hub that does not send it matches nothing (the field
 * is optional here until the server sends it for every build).
 */
type StoredPreview = DesignPreviewView & { repoId?: RepoId };

/** The ticket number in `repo#n`, or null for an item without a ticket. */
export function ticketNumber(ticket: string | null): number | null {
  const n = /#([1-9]\d*)$/.exec(ticket ?? "")?.[1];
  return n === undefined ? null : Number(n);
}

/**
 * A branch's built app over the whole window, under a 40 px bar. The app lays out by viewport
 * width, so a column would show a layout that never ships. Mounted by the ticket's ItemDetail; it
 * shows only that ticket's preview, and closes when the item changes or goes away.
 */
export function PreviewFrame({ ticket, label }: { ticket: number; label: string }) {
  const current = useStore(open);
  const shown = current?.view.ticket === ticket ? current : null;
  const url = shown?.view.url === `${PREVIEW_ORIGIN}/` ? shown.view.url : null;
  useOverlay("design-preview", url !== null, closePreview);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (url !== null) close.current?.focus();
  }, [url]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes when the ticket changes
  useEffect(() => closePreview, [ticket]);
  if (shown === null || url === null) return null;
  return (
    <div
      className="preview-frame"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${label}`}
    >
      <div className="preview-bar">
        <b className="preview-question" title={shown.question}>
          {shown.question}
        </b>
        <a className="sm" href={url} target="_blank" rel="noopener noreferrer">
          Open in a new tab
        </a>
        <button type="button" className="sm" ref={close} onClick={closePreview}>
          Close
        </button>
      </div>
      <iframe
        key={`${shown.view.ticket}:${shown.view.sha}`}
        className="preview-iframe"
        title={`Preview of ${label}`}
        src={url}
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}

/**
 * `Open preview` for an item whose ticket has a stored preview, and the frame it opens. The hub
 * lists only builds whose PR is still open, so a closed PR offers nothing. Demo has no previews.
 */
export function PreviewOpener({ item }: { item: AttentionItem }) {
  const ticket = ticketNumber(item.ticket);
  const demo = useDemo();
  const list = useResource<StoredPreview[]>(
    ticket === null || demo ? null : RESOURCES.designPreviews,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item starts without the note
  useEffect(() => setNote(null), [item.key]);
  const mine = (v: StoredPreview) =>
    item.repoId !== null && v.repoId === item.repoId && v.ticket === ticket;
  if (ticket === null || !list.data?.some(mine)) return null;
  const question = item.brief?.ask ?? item.text;
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const view = await apiPost<StoredPreview>(`/api/design-previews/${ticket}/open`);
      if (!mine(view)) throw new ApiError(404, PREVIEW_GONE_TEXT);
      openPreview(view, question);
    } catch (e) {
      const missing = e instanceof ApiError && e.status === 404;
      setNote(missing ? PREVIEW_GONE_TEXT : `Could not open the preview: ${(e as Error).message}`);
      if (missing) hub.refetch(RESOURCES.designPreviews.path);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row preview-open">
      <button type="button" className="sm" disabled={busy} onClick={() => void run()}>
        Open preview
      </button>
      {note && (
        <span className="note" role="status">
          {note}
        </span>
      )}
      <PreviewFrame ticket={ticket} label={item.ticket ?? ""} />
    </div>
  );
}
