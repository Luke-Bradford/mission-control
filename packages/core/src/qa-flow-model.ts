/** Shared vocabulary and data shapes; independent of the domain algorithms. */

/** What a bug ticket's body names. */
export interface DefectRefs {
  prs: number[];
  shas: string[];
  paths: string[];
}

export type DefectVia = "pr" | "commit" | "file";

export interface PrFileInput {
  path: string;
  changeType: string;
}
