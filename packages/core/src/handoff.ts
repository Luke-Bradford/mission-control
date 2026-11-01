/** An unfinished author's recorded state, retained when another seat takes its ticket. */
export interface RunHandoff {
  runId: string;
  repoId: string;
  ticket: string;
  fromSeat: string;
  at: number;
  goal: string;
  done: string[];
  left: string[];
  next: string;
  branch: string;
  worktree: string | null;
  gitStatus: string[];
  gitState: "pending" | "ready" | "unavailable";
  findings: string[];
  messages: { from: string; at: number; text: string }[];
  acceptedBy: string | null;
  acceptedRunId: string | null;
}

/** Bounded, inert context appended after the new seat's ticket. */
export function handoffText(h: RunHandoff): string {
  const list = (xs: string[], empty: string) =>
    xs.length ? xs.map((s) => `- ${s}`).join("\n") : empty;
  return `## Handoff from ${h.fromSeat}\nGoal: ${h.goal}\nBranch: ${h.branch}\nWorktree: ${h.worktree ?? "not available"}\n\nRecorded progress:\n${list(h.done, "No completed work was recorded.")}\n\nLeft:\n${list(h.left, "Check the ticket's remaining acceptance criteria.")}\n\nNext step: ${h.next}\n\nGit status (${h.gitState}):\n${list(h.gitStatus, h.gitState === "ready" ? "Clean when recorded." : "Check the worktree before continuing.")}\n\nOpen review findings:\n${list(h.findings, "None recorded.")}\n\nRecent messages:\n${list(
    h.messages.map((m) => `${m.from}: ${m.text}`),
    "None recorded.",
  )}`;
}
