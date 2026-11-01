/**
 * The preview a web PR's review runs against: a copy of the PR head on a copy of the live data
 * (the branch preview manager), started when the review run starts, kept alive while the run is
 * open and closed when it ends. The build runs in the background; the browser tool waits for it.
 */
import { globMatches } from "@mc/core";
import { PreviewHubError, type PreviewManager, type PreviewView } from "./previews.ts";

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
  open(input: {
    runId: string;
    repoId: string;
    pr: number;
    branch: string;
    sha: string;
  }): Promise<boolean>;
  /** Waits for the run's preview to start or fail. `origin` is null when there is none to use. */
  ready(
    runId: string,
  ): Promise<{ origin: string | null; note: string | null; identity: string | null }>;
  /** The origin of the run's preview while it is still the one running; otherwise null. */
  origin(runId: string): string | null;
  /** The live preview instance and immutable head, for queued tool calls. */
  identity(runId: string): string | null;
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
  view: PreviewView | null;
  sha: string;
  controller: AbortController;
  /** This run started the preview (an operator's is used and left running). */
  owned: boolean;
  /** Why there is no preview, once the start has failed. */
  note: string | null;
  timer: ReturnType<typeof setInterval> | null;
  done: Promise<void>;
}

function sameView(a: PreviewView | null, b: PreviewView): boolean {
  return (
    a?.url === b.url &&
    a.startedAt === b.startedAt &&
    a.sha === b.sha &&
    a.instanceId === b.instanceId
  );
}

export function createReviewPreviews(deps: ReviewPreviewDeps): ReviewPreviews {
  const entries = new Map<string, Entry>();
  const log = (line: string): void => deps.log?.(line);

  /** Closes the preview this run started, unless it has since been replaced by another. */
  async function release(entry: Entry): Promise<void> {
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.timer = null;
    if (!entry.owned || entry.view === null) return;
    if (!sameView(deps.previews.get(entry.pr), entry.view)) return;
    await deps.previews.close(entry.pr).catch((e) => {
      log(`review preview for PR ${entry.pr} did not close: ${e instanceof Error ? e.message : e}`);
    });
  }

  async function start(
    entry: Entry,
    input: { pr: number; branch: string; checkout: string; sha: string; signal: AbortSignal },
  ): Promise<void> {
    try {
      entry.view = await deps.previews.start(input);
      entry.owned = true;
    } catch (e) {
      if (e instanceof PreviewHubError && e.code === "already-running") {
        // A preview the operator started: use it, and leave it running afterwards.
        const existing = deps.previews.get(input.pr);
        if (existing?.sha === entry.sha) entry.view = existing;
        else entry.note = "the operator's preview is for a different or unknown head";
      }
      if (entry.view === null) {
        entry.note ??= e instanceof Error ? e.message : String(e);
        log(`review preview for PR ${input.pr} did not start: ${entry.note}`);
        return;
      }
    }
    if (entry.view?.sha !== entry.sha) {
      entry.note = "the preview did not start on the reviewed head";
      await release(entry);
      entry.view = null;
      return;
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
    return entry.view.sha === entry.sha && sameView(running, entry.view) ? entry.view.url : null;
  };

  const identity = (runId: string): string | null => {
    if (origin(runId) === null) return null;
    const view = entries.get(runId)?.view;
    return view ? JSON.stringify([view.url, view.startedAt, view.sha, view.instanceId]) : null;
  };

  return {
    origin,
    identity,
    async open({ runId, repoId, pr, branch, sha }) {
      if (!isWebPr(deps.files(repoId, pr), await deps.webGlobs(repoId))) return false;
      const entry: Entry = {
        pr,
        sha,
        controller: new AbortController(),
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
      else
        entry.done = start(entry, { pr, branch, checkout, sha, signal: entry.controller.signal });
      return true;
    },
    async ready(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return { origin: null, note: null, identity: null };
      await entry.done;
      const url = origin(runId);
      return {
        origin: url,
        identity: identity(runId),
        note: url !== null ? null : (entry.note ?? "the preview is no longer running"),
      };
    },
    async close(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return;
      entries.delete(runId);
      entry.closed = true;
      // Abort only this run's reservation; an operator's pending/running preview stays untouched.
      entry.controller.abort();
      await entry.done;
      await release(entry);
    },
  };
}
