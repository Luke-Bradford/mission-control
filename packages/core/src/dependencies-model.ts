/** Shared data and helpers; independent of domain control flow. */

/** The issue a wait names (`repo#number`) or the PR (`PR number`), and how it reads in a refusal. */
export interface DependencyWait {
  ref: string;
  text: string;
  /** The hub never read this PR: it gates a start, but its ending is not a release. */
  unread?: true;
}

export interface ChainNode {
  ref: string;
  title: string | null;
  edge: "depends" | "stacked" | "held" | "queue" | null;
  waitedMs: number | null;
  alsoWaitsOn: string[];
  children: ChainNode[];
}

export interface DependencyChain {
  repoId: string;
  root: ChainNode;
  state: "stuck" | "with-you" | "moving" | "unknown";
  reason: string;
  owner: string;
  seatId: string | null;
  longestWaitMs: number | null;
  frees: string[];
  stillWaiting: string[];
}

/** Canonical work identities and facts, supplied by the server's read adapter. */
export interface DependencyWork {
  ref: string;
  title: string | null;
  state: DependencyChain["state"];
  reason: string;
  owner: string;
  seatId: string | null;
}

/** A dependent waits on a blocker. A missing observed start stays unknown. */
export interface DependencyEdge {
  from: string;
  to: string;
  kind: NonNullable<ChainNode["edge"]>;
  since: number | null;
}
