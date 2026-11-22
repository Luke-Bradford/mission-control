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
