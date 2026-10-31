/**
 * The preview a web PR's review runs against: a copy of the PR head on a copy of the live data
 * (the branch preview manager), started when the review run starts, kept alive while the run is
 * open and closed when it ends. The build runs in the background; the browser tool waits for it.
 */
import { globMatches } from "@mc/core";
import { PreviewHubError, type PreviewManager } from "./previews.ts";

/** The area label whose globs mark a PR as a web change. */
export const WEB_AREA_LABEL = "area:web";
/** How often a run's preview is touched, so the manager's idle expiry does not close it. */
export const REVIEW_PREVIEW_TOUCH_MS = 60_000;

export interface ReviewPreviewDeps {
  previews: Pick<PreviewManager, "start" | "close" | "get" | "touch">;
  /** The paths the PR changes (`pr_files`). */
  files(repoId: string, pr: number): readonly string[];
  /** The repo's web area globs (the `area:web` entry of its Mission Control block). */
  webGlobs(repoId: string): Promise<readonly string[]>;
  /** The crew clone the preview fetches the PR head into. */
  checkout(repoId: string): string | null;
  log?: (line: string) => void;
}

export interface ReviewPreviews {
  /**
   * Starts a preview of the PR head in the background when it changes web files. Resolves once
   * that is decided, not when the build ends: true means a preview is starting for this run.
   */
  open(input: { runId: string; repoId: string; pr: number; branch: string }): Promise<boolean>;
  /** Waits for the run's preview to start or fail. `origin` is null when there is none to use. */
  ready(runId: string): Promise<{ origin: string | null; note: string | null }>;
  /** The origin of the run's preview while it is still the one running; otherwise null. */
  origin(runId: string): string | null;
  /** Stops keeping the preview alive and closes it if this run started it. */
  close(runId: string): Promise<void>;
}

/** Whether any changed path is under one of the web globs. */
export function isWebPr(files: readonly string[], globs: readonly string[]): boolean {
  return files.some((f) => globs.some((g) => globMatches(g, f)));
}

interface Entry {
  pr: number;
  closed: boolean;
  /** The preview this run uses, as the manager reported it. */
  view: { url: string; startedAt: number } | null;
  /** This run started the preview (an operator's is used and left running). */
  owned: boolean;
  /** Why there is no preview, once the start has failed. */
  note: string | null;
  timer: ReturnType<typeof setInterval> | null;
  done: Promise<void>;
}

export function createReviewPreviews(deps: ReviewPreviewDeps): ReviewPreviews {
  const entries = new Map<string, Entry>();
  const log = (line: string): void => deps.log?.(line);

  /** Closes the preview this run started, unless it has since been replaced by another. */
  async function release(entry: Entry): Promise<void> {
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.timer = null;
    if (!entry.owned || entry.view === null) return;
    if (deps.previews.get(entry.pr)?.startedAt !== entry.view.startedAt) return;
    await deps.previews.close(entry.pr).catch((e) => {
      log(`review preview for PR ${entry.pr} did not close: ${e instanceof Error ? e.message : e}`);
    });
  }

  async function start(
    entry: Entry,
    input: { pr: number; branch: string; checkout: string },
  ): Promise<void> {
    try {
      entry.view = await deps.previews.start(input);
      entry.owned = true;
    } catch (e) {
      if (e instanceof PreviewHubError && e.code === "already-running") {
        // A preview the operator started: use it, and leave it running afterwards.
        entry.view = deps.previews.get(input.pr);
      }
      if (entry.view === null) {
        entry.note = e instanceof Error ? e.message : String(e);
        log(`review preview for PR ${input.pr} did not start: ${entry.note}`);
        return;
      }
    }
    if (entry.closed) {
      await release(entry);
      return;
    }
    // Reading a long diff must not let the idle expiry close the preview before the browser is used.
    entry.timer = setInterval(() => deps.previews.touch(input.pr), REVIEW_PREVIEW_TOUCH_MS);
    entry.timer.unref?.();
  }

  const origin = (runId: string): string | null => {
    const entry = entries.get(runId);
    if (!entry?.view || entry.closed) return null;
    const running = deps.previews.get(entry.pr);
    return running?.url === entry.view.url && running.startedAt === entry.view.startedAt
      ? entry.view.url
      : null;
  };

  return {
    origin,
    async open({ runId, repoId, pr, branch }) {
      if (!isWebPr(deps.files(repoId, pr), await deps.webGlobs(repoId))) return false;
      const entry: Entry = {
        pr,
        closed: false,
        view: null,
        owned: false,
        note: null,
        timer: null,
        done: Promise.resolve(),
      };
      entries.set(runId, entry);
      const checkout = deps.checkout(repoId);
      if (checkout === null) entry.note = "the repo has no crew clone to build the PR head in";
      else entry.done = start(entry, { pr, branch, checkout });
      return true;
    },
    async ready(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return { origin: null, note: null };
      await entry.done;
      const url = origin(runId);
      return {
        origin: url,
        note: url !== null ? null : (entry.note ?? "the preview is no longer running"),
      };
    },
    async close(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return;
      entries.delete(runId);
      entry.closed = true;
      // A build still going is aborted by closing its PR; one that finished is released below.
      if (entry.view === null && entry.note === null)
        await deps.previews.close(entry.pr).catch(() => {});
      await entry.done;
      await release(entry);
    },
  };
}
