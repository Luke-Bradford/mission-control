import type { CrewRow } from "@mc/core";
import { useEffect, useState } from "react";

/** How present a seat is: running seats glow, idle ones dim, stopped or paused ones fade back. */
export type Presence = "running" | "idle" | "stopped";

export function presenceOf(row: CrewRow): Presence {
  if (row.paused || row.crewPause != null || row.hudState === "stopped") return "stopped";
  return row.hudState === "running" ? "running" : "idle";
}

/** A link's newest message, for the hover card. */
export type LastMessage = { from: string; to: string; text: string; at: number };

/** New messages seen on the last read: one travelling dot each (a few at most per link). */
export type Flow = { from: string; to: string; n: number };
export type Flows = { generation: number; list: Flow[] };

/** One unanswered question or blocker, as `/api/comms/open` lists it. `text` is absent on older hubs. */
export type OpenItem = {
  id: string;
  label: string;
  from: string;
  to: string;
  ticket: string | null;
  waitedMs: number;
  text?: string | null;
  question?: string | null;
};

/** One message from the per-message feed `/api/comms/feed` (absent on older hubs). */
export type FeedMessage = { id: string; from: string; to: string; at: number; text: string };

/** What is waiting on one link: how many, the longest wait, who asked, and the oldest question. */
export type Waiting = {
  n: number;
  ms: number;
  asker: string;
  /** The addressee of the oldest unanswered ask: this is the seat that owes the reply. */
  owed?: string;
  question: string | null;
};

/** `<1m`, `12m`, `2h 5m`, `3d`: a wait in words, so it is read and not only seen. */
export function waitWord(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

const reducedMotionQuery = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** True while the operator asks for reduced motion; follows the setting live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const media = reducedMotionQuery();
    if (!media) return;
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener?.("change", change);
    return () => media.removeEventListener?.("change", change);
  }, []);
  return reduced;
}
