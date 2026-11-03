import { type PillTone, type ReviewCheckState, reviewCheckPill } from "@mc/core";
import { useId, useState } from "react";
import { useNow } from "../clock.ts";
import { Pill, PillButton } from "./Pill.tsx";
import "./ReviewState.css";

/** Primitive status props keep a ticking review age out of its parent card and controls. */
export interface ReviewStateProps {
  label: string;
  tone: PillTone;
  checkingSeat?: string;
  checkingSince?: number;
  reason?: string | null;
}

function CheckingAge({ seat, since }: { seat: string; since: number }) {
  const now = useNow();
  const pill = reviewCheckPill({ kind: "checking", seat, since }, now);
  return <Pill tone={pill.tone}>{pill.label}</Pill>;
}

export function ReviewState({
  label,
  tone,
  checkingSeat,
  checkingSince,
  reason,
}: ReviewStateProps) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const pill =
    checkingSeat !== undefined && checkingSince !== undefined ? (
      <CheckingAge seat={checkingSeat} since={checkingSince} />
    ) : (
      <Pill tone={tone}>{label}</Pill>
    );
  if (!reason) return pill;
  return (
    <span className="review-state-reason">
      {pill}
      <PillButton
        tone="plain"
        aria-expanded={open}
        aria-controls={reasonId}
        aria-label={`Reason for ${label}`}
        onClick={() => setOpen(!open)}
      >
        Reason
      </PillButton>
      <span id={reasonId} className="review-state-detail" hidden={!open}>
        {reason}
      </span>
    </span>
  );
}

/** Current-head state comes from the server; no previous report is promoted to current. */
export function reviewStateProps(check: ReviewCheckState): ReviewStateProps {
  const pill = reviewCheckPill(check, check.kind === "checking" ? check.since : 0);
  return {
    label: pill.label,
    tone: pill.tone,
    checkingSeat: check.kind === "checking" ? check.seat : undefined,
    checkingSince: check.kind === "checking" ? check.since : undefined,
    reason: check.kind === "held" ? check.reason : undefined,
  };
}

export function ReviewCheck({ check }: { check: ReviewCheckState }) {
  return <ReviewState {...reviewStateProps(check)} />;
}
