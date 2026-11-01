/** Shared data and helpers; independent of domain control flow. */

/** The issue a wait names (`repo#number`) or the PR (`PR number`), and how it reads in a refusal. */
export interface DependencyWait {
  ref: string;
  text: string;
  /** The hub never read this PR: it gates a start, but its ending is not a release. */
  unread?: true;
}
