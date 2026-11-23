/**
 * A PR's before and after pictures as the files of one GitHub release (tag `qa-pr-<n>`), so the PR
 * body can show them. Only Demo data is ever in them. The release is made with the head's picture
 * set, replaced when the head changes, and removed once the change is live.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EVIDENCE_RELEASE_PREFIX, evidenceReleaseTag } from "@mc/core";
import type { GhRunner } from "../mcp/gh.ts";
import type { EvidenceImage } from "./store.ts";

/** The most releases one clean-up reads. */
const RELEASES_LISTED = 200;

/** Deletes the PR's picture release and its tag; true when it is gone (or never was). */
export async function deleteEvidenceRelease(
  gh: GhRunner,
  cwd: string,
  repo: string,
  pr: number,
): Promise<boolean> {
  const r = await gh(
    ["release", "delete", evidenceReleaseTag(pr), "--repo", repo, "--cleanup-tag", "--yes"],
    { cwd },
  );
  return r.code === 0;
}

/**
 * Replaces the PR's release with one holding `images`, tagged at `sha`, and returns the folder URL
 * its files download from. Throws when GitHub refuses.
 */
export async function publishEvidenceRelease(o: {
  gh: GhRunner;
  cwd: string;
  /** `owner/name` */
  repo: string;
  pr: number;
  sha: string;
  images: readonly EvidenceImage[];
  /** Where the files are written for upload; removed afterwards. */
  scratch: string;
}): Promise<string> {
  const tag = evidenceReleaseTag(o.pr);
  await mkdir(o.scratch, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(o.scratch, "release-"));
  try {
    const files: string[] = [];
    for (const i of o.images) {
      const file = join(dir, i.name);
      await writeFile(file, i.png, { mode: 0o600 });
      files.push(file);
    }
    // The previous head's release (and its tag) goes first; no release yet is fine.
    await deleteEvidenceRelease(o.gh, o.cwd, o.repo, o.pr);
    const made = await o.gh(
      [
        "release",
        "create",
        tag,
        ...files,
        "--repo",
        o.repo,
        "--target",
        o.sha,
        "--prerelease",
        "--title",
        `QA pictures for PR ${o.pr}`,
        "--notes",
        "Demo-data before and after pictures of the pages this PR changes. Removed once the change is live.",
      ],
      { cwd: o.cwd, timeoutMs: 5 * 60_000 },
    );
    if (made.code !== 0) throw new Error(`the release for PR ${o.pr} could not be created`);
    return `https://github.com/${o.repo}/releases/download/${tag}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Deletes the picture releases of PRs `keep` does not hold (finished: live, or closed). Returns the
 * PR numbers removed. A release that cannot be deleted is left for the next run.
 */
export async function removeFinishedEvidenceReleases(o: {
  gh: GhRunner;
  cwd: string;
  repo: string;
  keep(pr: number): boolean;
}): Promise<number[]> {
  const listed = await o.gh(
    ["release", "list", "--repo", o.repo, "--limit", String(RELEASES_LISTED), "--json", "tagName"],
    { cwd: o.cwd },
  );
  if (listed.code !== 0) throw new Error("the releases could not be listed");
  const tags = (JSON.parse(listed.stdout) as { tagName?: string }[])
    .map((r) => r.tagName ?? "")
    .filter((t) => new RegExp(`^${EVIDENCE_RELEASE_PREFIX}[1-9][0-9]*$`).test(t));
  const removed: number[] = [];
  for (const tag of tags) {
    const pr = Number(tag.slice(EVIDENCE_RELEASE_PREFIX.length));
    if (o.keep(pr)) continue;
    if (await deleteEvidenceRelease(o.gh, o.cwd, o.repo, pr)) removed.push(pr);
  }
  return removed;
}
