/** origin's refs from one `git ls-remote --symref`: shared by the seat's push and the hub's own merges. */
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** origin's default branch (name and tip) and the run's branch tip, from one `ls-remote`. */
export interface OriginHeads {
  defaultBranch: string;
  defaultSha: string;
  branchSha: string | null;
}

export function originHeads(out: string, branch: string | null): OriginHeads {
  let defaultRef: string | null = null;
  let defaultSha: string | null = null;
  let branchSha: string | null = null;
  for (const line of out.split("\n")) {
    const [left = "", name = ""] = line.split("\t");
    if (name !== "HEAD" && name !== `refs/heads/${branch}`) continue;
    if (left.startsWith("ref: ")) {
      if (name === "HEAD") defaultRef = left.slice("ref: ".length);
    } else if (SHA.test(left)) {
      if (name === "HEAD") defaultSha = left;
      else branchSha = left;
    }
  }
  const defaultBranch = defaultRef?.startsWith("refs/heads/")
    ? defaultRef.slice("refs/heads/".length)
    : null;
  if (defaultBranch === null || defaultSha === null || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("origin has no default branch");
  }
  return { defaultBranch, defaultSha, branchSha };
}
