import { type PullRequestView, prPill, type RunPr } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { Pill, PillButton } from "./Pill.tsx";
import { RepoRef } from "./RepoRef.tsx";
import "./PrChip.css";

/**
 * A PR a run published: its repo chip and `PR #3240` linked to GitHub (plain text when no
 * https://github.com URL can be made), its title on hover, and a pill once it is merged or
 * closed, and a "held" pill while FLIGHT or the controller holds its merge. `bare` leaves the repo chip out, for a page that shows one repo.
 */
/** A running branch preview, added to Board and Agent PR payloads by the server. */
export interface PrPreview {
  pr: number;
  branch: string;
  port: number;
  url: string;
  startedAt: number;
}

function previewUrl(preview: PrPreview | null | undefined): string | null {
  if (!preview) return null;
  try {
    const url = new URL(preview.url);
    return url.protocol === "http:" || url.protocol === "https:" ? preview.url : null;
  } catch {
    return null;
  }
}

/**
 * A PR published by a run, with its GitHub reference and any live branch preview. The preview
 * arrives with the Board or Agent PR row; this component never lists previews itself.
 */
export function PrChip({
  pr,
  bare,
  preview: initialPreview,
  showState = true,
}: {
  pr: RunPr | PullRequestView;
  bare?: boolean;
  preview?: PrPreview | null;
  /** The Board owns its full PR status line, so it supplies this as false. */
  showState?: boolean;
}) {
  const [preview, setPreview] = useState(initialPreview ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pill = pr.state === "merged" || pr.state === "closed" ? prPill({ state: pr.state }) : null;
  const hold = "hold" in pr ? pr.hold : undefined;
  const url = previewUrl(preview);
  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      setPreview(await apiPost<PrPreview>("/api/previews", { pr: pr.number }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start preview.");
    } finally {
      setStarting(false);
    }
  };
  return (
    <span className="rpr">
      <RepoRef
        repoId={pr.repoId}
        number={pr.number}
        kind="pr"
        bare={bare}
        title={pr.title ?? undefined}
        url={pr.url}
      />
      {showState && pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
      {initialPreview !== undefined &&
        (url ? (
          <a
            className="pill ok preview-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open preview for PR #${pr.number}`}
          >
            Preview
          </a>
        ) : (
          <PillButton
            tone="plain"
            className="preview-start"
            aria-label={`Start preview for PR #${pr.number}`}
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : "Start preview"}
          </PillButton>
        ))}
      {error && (
        <span className="s crit-t preview-error" role="alert">
          {error}
        </span>
      )}
      {hold && (
        <Pill tone="warn" title={`merge held by ${hold.by}: ${hold.reason}`}>
          held
        </Pill>
      )}
    </span>
  );
}
