/**
 * What a seat keeps beyond its CLI session (#2319): run notes per ticket, which the seat writes
 * with `run_notes`, and lessons per repo, which seats propose with `propose_lesson` and FLIGHT
 * accepts or rejects with `decide_lesson`. A fresh session (past the context line, after a CLI
 * update, after a crash) starts from them instead of resuming. Both live in the hub's database only.
 */
import { FLIGHT_CONTEXT_ROTATE_TOKENS } from "./flight.ts";

/** A seat's context past this many tokens at a turn's end gets a fresh session: FLIGHT's line. */
export const SEAT_CONTEXT_ROTATE_TOKENS = FLIGHT_CONTEXT_ROTATE_TOKENS;
/** Fresh sessions one run may have in `SEAT_FRESH_WINDOW_MS` before the hub stops starting them. */
export const SEAT_FRESH_MAX = 3;
export const SEAT_FRESH_WINDOW_MS = 60 * 60_000;
/** The setting that holds when a run's recent fresh sessions started (a JSON list of times). */
export const seatFreshKey = (runId: string): string => `seat-fresh:${runId}`;

/** The longest one run-notes line is (done, a blocker, a decision, or next). */
export const RUN_NOTE_LINE_MAX = 500;
/** The most lines one run-notes list holds. */
export const RUN_NOTE_LINES_MAX = 20;
/** The longest a lesson is. */
export const REPO_LESSON_MAX = 600;
/** How many accepted lessons a start brief lists, newest first. */
export const REPO_LESSONS_BRIEFED = 20;
/** How many of a run's hub events a fresh brief lists, newest last. */
export const RUN_NOTE_EVENTS_MAX = 15;

/** The seat's own part of a ticket's run notes; each write replaces it whole. */
export interface RunNotes {
  done: string[];
  next: string;
  blockers: string[];
  decisions: string[];
}
export interface StoredRunNotes extends RunNotes {
  repoId: string;
  ticket: string;
  runId: string;
  seatId: string;
  updatedAt: number;
}

export const REPO_LESSON_STATES = ["proposed", "accepted", "rejected"] as const;
export type RepoLessonState = (typeof REPO_LESSON_STATES)[number];
export interface RepoLesson {
  id: number;
  repoId: string;
  text: string;
  seatId: string;
  runId: string | null;
  at: number;
  state: RepoLessonState;
  decidedAt: number | null;
  decidedBy: string | null;
}

/** Why a seat gets a fresh session. */
export type FreshWhy = "context" | "cli-version" | "crash";
export const FRESH_WHY_TEXT: Readonly<Record<FreshWhy, string>> = {
  context: `its context passed ${SEAT_CONTEXT_ROTATE_TOKENS / 1000}K tokens`,
  "cli-version": "the Claude CLI was updated",
  crash: "its CLI stopped mid-run",
};
export const freshEventText = (why: FreshWhy): string => `Fresh session: ${FRESH_WHY_TEXT[why]}`;

export const RUN_NOTES_SAVED = "Run notes saved. A fresh session of this ticket starts from them.";
export const runNotesSecretText = (kind: string): string =>
  `Not saved: the notes hold what looks like a ${kind}. Take it out and save again.`;
export const lessonProposedText = (id: number): string =>
  `Lesson ${id} proposed. FLIGHT accepts or rejects it; once accepted, every seat on this repo reads it at start.`;
export const lessonSecretText = (kind: string): string =>
  `Not proposed: the lesson holds what looks like a ${kind}. Take it out and propose again.`;
export const lessonCommsText = (id: number, text: string): string =>
  `Lesson ${id} proposed for this repo: ${text}\nAccept or reject it with mc decide_lesson.`;
export const lessonDecidedText = (id: number, accept: boolean): string =>
  `Lesson ${id} ${accept ? "accepted: seats on its repo read it at start" : "rejected"}.`;
export const lessonMissingText = (id: number): string => `No proposed lesson ${id} on this repo.`;

export const RUN_NOTES_LINE =
  "Keep your run notes current with mc run_notes after each commit and before you report: done, next, blockers and decisions. A fresh session of this ticket starts from them. When you find a fix or gotcha about this repo's environment that the next seat would need, propose it with mc propose_lesson.";

/** The start and fresh briefs' "Repo lessons" section; nothing when none are accepted. */
export function lessonsSection(lessons: readonly Pick<RepoLesson, "text">[]): string[] {
  if (lessons.length === 0) return [];
  return [
    "## Repo lessons",
    "",
    "Lessons earlier seats learned about this repo, accepted by FLIGHT:",
    "",
    ...lessons.slice(0, REPO_LESSONS_BRIEFED).map((l) => `- ${oneLine(l.text)}`),
    "",
  ];
}

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim();

/** The run notes as a brief lists them: the seat's part, then the hub's events. */
export function runNotesText(
  notes: RunNotes | null,
  events: readonly { at: number; text: string }[],
): string | null {
  const lines: string[] = [];
  if (notes !== null) {
    if (notes.done.length > 0) lines.push("Done:", ...notes.done.map((d) => `- ${oneLine(d)}`));
    if (notes.next.trim() !== "") lines.push(`Next: ${oneLine(notes.next)}`);
    if (notes.blockers.length > 0)
      lines.push("Blockers:", ...notes.blockers.map((b) => `- ${oneLine(b)}`));
    if (notes.decisions.length > 0)
      lines.push("Decisions:", ...notes.decisions.map((d) => `- ${oneLine(d)}`));
  }
  if (events.length > 0)
    lines.push(
      "Hub events:",
      ...events
        .slice(-RUN_NOTE_EVENTS_MAX)
        .map((e) => `- ${new Date(e.at).toISOString()} ${oneLine(e.text)}`),
    );
  return lines.length === 0 ? null : lines.join("\n");
}
