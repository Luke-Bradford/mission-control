import {
  type PullRequestPreviewFacts,
  type PullRequestView,
  prPill,
  type RunPr,
  reviewCheckPill,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { useNow } from "../clock.ts";
import { ACTIONS, hub } from "../data.ts";
import { ticketPath } from "../router.ts";
import { Pill, PillButton } from "./Pill.tsx";
import { parseTicket, RepoRef } from "./RepoRef.tsx";
import "./PrChip.css";

/** Preview facts arrive with the Board and Agent PR rows; capability is decided by the server. */
export type PrPreview = NonNullable<PullRequestPreviewFacts["preview"]>;
export type PreviewPr = PullRequestView & Partial<PullRequestPreviewFacts>;

function previewUrl(preview: PrPreview | null | undefined): string | null {
  if (!preview) return null;
  try {
    const url = new URL(preview.url);
    return url.protocol === "http:" || url.protocol === "https:" ? preview.url : null;
  } catch {
    return null;
  }
}

/** Starts a supported preview and keeps its link in step with the PR payload. */
function PreviewAction({
  number,
  initialPreview,
  startable,
}: {
  number: number;
  initialPreview?: PrPreview | null;
  startable: boolean;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const focusLink = useRef(false);
  const link = useRef<HTMLAnchorElement>(null);
  const url = previewUrl(preview);
  useEffect(() => {
    setPreview(initialPreview);
    setError(null);
  }, [initialPreview]);
  useEffect(() => {
    if (url && focusLink.current) {
      link.current?.focus();
      focusLink.current = false;
    }
  }, [url]);
  if (url)
    return (
      <a
        ref={link}
        className="pill ok preview-link"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open preview for PR #${number}`}
      >
        Preview
      </a>
    );
  if (!startable) return null;
  return (
    <>
      <PillButton
        tone="plain"
        className="preview-start"
        aria-label={`Start preview for PR #${number}`}
        aria-busy={starting}
        disabled={starting}
        onClick={async (event) => {
          event.stopPropagation();
          if (pending.current) return;
          focusLink.current = document.activeElement === event.currentTarget;
          pending.current = true;
          setStarting(true);
          setError(null);
          try {
            setPreview(await apiPost<PrPreview>(ACTIONS.startPreview, { pr: number }));
            hub.refetchTopic("boards");
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "Could not start the preview. Try again.",
            );
          } finally {
            pending.current = false;
            setStarting(false);
          }
        }}
      >
        {starting ? "Starting preview…" : "Start preview"}
      </PillButton>
      {error && (
        <span className="preview-error crit-t" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * A PR published by a run, with its GitHub reference and any live branch preview. The preview
 * arrives with the Board or Agent PR row; this component never lists previews itself.
 */
export function PrChip({
  pr,
  bare,
  preview: initialPreview,
  previewable = false,
  showState = true,
}: {
  pr: RunPr | PullRequestView;
  bare?: boolean;
  preview?: PrPreview | null;
  previewable?: boolean;
  /** The Board owns its full PR status line, so it supplies this as false. */
  showState?: boolean;
}) {
  const now = useNow();
  const check = "check" in pr && pr.state === "open" ? pr.check : null;
  const pill =
    pr.state === "merged" || pr.state === "closed"
      ? prPill({ state: pr.state })
      : check
        ? reviewCheckPill(check, now)
        : null;
  const hold = "hold" in pr ? pr.hold : undefined;
  const ticket = pr.ticket ? parseTicket(pr.ticket) : null;
  return (
    <span className="rpr">
      <RepoRef
        repoId={pr.repoId}
        number={pr.number}
        kind="pr"
        bare={bare}
        title={pr.title ?? undefined}
        url={pr.url}
        to={ticket ? ticketPath(ticket.repoId, ticket.number) : undefined}
      />
      {showState && pr.state === "open" && pr.uat ? (
        <Pill tone="warn">Waiting for your acceptance</Pill>
      ) : showState && pill ? (
        <Pill tone={pill.tone}>{pill.label}</Pill>
      ) : null}
      <PreviewAction
        key={`${pr.repoId}:${pr.number}`}
        number={pr.number}
        initialPreview={initialPreview}
        startable={previewable && pr.state === "open" && initialPreview == null}
      />
      {hold && (
        <Pill tone="warn" title={`merge held by ${hold.by}: ${hold.reason}`}>
          held
        </Pill>
      )}
    </span>
  );
}
