/**
 * The preview a web PR's review runs against: a copy of the PR head on a copy of the live data
 * (the branch preview manager), opened when the review run starts and closed when it ends.
 */
import { globMatches } from "@mc/core";
import { PreviewHubError, type PreviewManager } from "./previews.ts";

/** The area label whose globs mark a PR as a web change. */
export const WEB_AREA_LABEL = "area:web";

export interface ReviewPreviewDeps {
  previews: Pick<PreviewManager, "start" | "close" | "get">;
  /** The paths the PR changes (`pr_files`). */
  files(repoId: string, pr: number): readonly string[];
  /** The repo's web area globs (the `area:web` entry of its Mission Control block). */
  webGlobs(repoId: string): Promise<readonly string[]>;
  /** The crew clone the preview fetches the PR head into. */
  checkout(repoId: string): string | null;
  log?: (line: string) => void;
}

export interface ReviewPreviews {
  /** The preview's origin for a review run that has one; otherwise null. */
  origin(runId: string): string | null;
  /**
   * Opens a preview for the PR when it changes web files. `null`: not a web PR, or it could not
   * start (the second field says why), and the review goes ahead without one.
   */
  open(input: {
    runId: string;
    repoId: string;
    pr: number;
    branch: string;
  }): Promise<{ origin: string | null; note: string | null }>;
  /** Closes the preview this run opened; one it did not open is left running. */
  close(runId: string): Promise<void>;
}

/** Whether any changed path is under one of the web globs. */
export function isWebPr(files: readonly string[], globs: readonly string[]): boolean {
  return files.some((f) => globs.some((g) => globMatches(g, f)));
}

export function createReviewPreviews(deps: ReviewPreviewDeps): ReviewPreviews {
  const origins = new Map<string, string>();
  /** The PR whose preview a run started, so only that run closes it. */
  const owned = new Map<string, number>();
  return {
    origin: (runId) => origins.get(runId) ?? null,
    async open({ runId, repoId, pr, branch }) {
      if (!isWebPr(deps.files(repoId, pr), await deps.webGlobs(repoId)))
        return { origin: null, note: null };
      const checkout = deps.checkout(repoId);
      if (checkout === null)
        return { origin: null, note: "the repo has no crew clone to build the PR head in" };
      try {
        const view = await deps.previews.start({ pr, branch, checkout });
        origins.set(runId, view.url);
        owned.set(runId, pr);
        return { origin: view.url, note: null };
      } catch (e) {
        if (e instanceof PreviewHubError && e.code === "already-running") {
          // A preview the operator started: use it, and leave it running afterwards.
          const running = deps.previews.get(pr);
          if (running) {
            origins.set(runId, running.url);
            return { origin: running.url, note: null };
          }
        }
        const reason = e instanceof Error ? e.message : String(e);
        deps.log?.(`review preview for PR ${pr} did not start: ${reason}`);
        return { origin: null, note: reason };
      }
    },
    async close(runId) {
      origins.delete(runId);
      const pr = owned.get(runId);
      if (pr === undefined) return;
      owned.delete(runId);
      await deps.previews.close(pr).catch((e) => {
        deps.log?.(
          `review preview for PR ${pr} did not close: ${e instanceof Error ? e.message : e}`,
        );
      });
    },
  };
}
