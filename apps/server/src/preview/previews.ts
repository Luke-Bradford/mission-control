import { randomBytes } from "node:crypto";
import { UNTRUSTED_PR } from "./trust.ts";

/** The ports reserved for branch preview hubs. */
export const PREVIEW_PORTS = [7431, 7432, 7433, 7434, 7435, 7436, 7437, 7438, 7439] as const;
export const PREVIEW_LIMIT = 2;
export const PREVIEW_IDLE_MS = 20 * 60_000;
export const PREVIEW_START_MS = 5 * 60_000;
export const PREVIEW_ACTIVITY_HEADER = "x-mc-preview-activity";

export type PreviewErrorCode =
  | "capacity"
  | "limit"
  | "already-running"
  | "no-port"
  | "head"
  | "untrusted";

/** A refusal a route can safely show to the operator. */
export class PreviewHubError extends Error {
  readonly code: PreviewErrorCode;
  constructor(code: PreviewErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PreviewProcess {
  stop(): void | Promise<void>;
}

export interface PreviewStart {
  /** The repo the PR belongs to; absent means the hub's own repo. */
  repoId?: string;
  pr: number;
  branch: string;
  checkout: string;
  /** An immutable head; absent only for legacy callers. */
  sha?: string;
  /** Cancels only this caller's reserved start. */
  signal?: AbortSignal;
}

export interface PreviewView {
  /** The repo the PR belongs to; absent for the hub's own repo. */
  repoId?: string;
  pr: number;
  branch: string;
  port: number;
  url: string;
  startedAt: number;
  sha?: string;
  instanceId?: string;
}

interface Preview extends PreviewView {
  dbPath: string;
  process: PreviewProcess;
  lastRequestAt: number;
  token: string;
}
interface PendingPreview {
  port: number;
  controller: AbortController;
  done: Promise<void>;
  resolve(): void;
}

export interface PreviewManagerDeps {
  now?: () => number;
  /** The hub's own repo: a preview with no `repoId`, or this one, is the same preview. */
  hubRepoId?: string;
  /** Whether another local listener owns this candidate port. */
  exists(port: number): boolean | Promise<boolean>;
  capacity(): { blocked: boolean; reason: string | null };
  /** Whether this PR head is from the crew or a collaborator; an untrusted head is never built. */
  trusted(input: { pr: number; sha?: string; repoId?: string }): Promise<boolean>;
  /** Creates its private DB, worktree and child before returning the live child handle. */
  start(
    input: PreviewStart & { port: number; token: string; signal: AbortSignal },
  ): Promise<PreviewProcess & { dbPath?: string }>;
  /** Deletes a private preview DB (and any sidecars) after its child ends. */
  remove(path: string): Promise<void>;
}

/** Owns the bounded, idle-expiring set of branch preview processes. */
export class PreviewManager {
  private readonly now: () => number;
  private readonly previews = new Map<string, Preview>();
  /** Starts reserve a PR and port before asynchronous checkout preparation begins. */
  private readonly pending = new Map<string, PendingPreview>();
  private reservations: Promise<void> = Promise.resolve();
  private readonly deps: PreviewManagerDeps;

  constructor(deps: PreviewManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** A preview's identity: the repo and PR number (the hub's own repo has an empty repo part). */
  private key(pr: number, repoId?: string): string {
    return `${repoId === undefined || repoId === this.deps.hubRepoId ? "" : repoId}#${pr}`;
  }

  list(): PreviewView[] {
    return [...this.previews.values()]
      .sort((a, b) => a.pr - b.pr)
      .map(
        ({
          dbPath: _dbPath,
          process: _process,
          lastRequestAt: _lastRequestAt,
          token: _token,
          ...view
        }) => view,
      );
  }

  get(pr: number, repoId?: string): PreviewView | null {
    const key = this.key(pr, repoId);
    return this.list().find((preview) => this.key(preview.pr, preview.repoId) === key) ?? null;
  }

  async start(input: PreviewStart): Promise<PreviewView> {
    if (input.sha !== undefined && !/^[a-f0-9]{40}$/i.test(input.sha))
      throw new PreviewHubError("head", "a preview head must be a full commit SHA");
    if (
      !(await this.deps.trusted({
        pr: input.pr,
        ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
        ...(input.sha === undefined ? {} : { sha: input.sha }),
      }))
    )
      throw new PreviewHubError("untrusted", UNTRUSTED_PR);
    const id = this.key(input.pr, input.repoId);
    const pending = await this.reserve(id);
    const abort = () => pending.controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const { port } = pending;
    const token = randomBytes(32).toString("base64url");
    let child: PreviewProcess & { dbPath?: string };
    const timeout = setTimeout(() => pending.controller.abort(), PREVIEW_START_MS);
    try {
      pending.controller.signal.throwIfAborted();
      child = await this.deps.start({ ...input, port, token, signal: pending.controller.signal });
      if (pending.controller.signal.aborted) {
        try {
          await child.stop();
        } finally {
          if (child.dbPath) await this.deps.remove(child.dbPath);
        }
        pending.controller.signal.throwIfAborted();
      }
    } catch (e) {
      this.release(id);
      throw e;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
    // The idle lifetime starts once the URL can actually be used, not while checkout/build runs.
    const startedAt = this.now();
    const preview: Preview = {
      ...(input.repoId === undefined || input.repoId === this.deps.hubRepoId
        ? {}
        : { repoId: input.repoId }),
      pr: input.pr,
      branch: input.branch,
      port,
      url: `http://127.0.0.1:${port}`,
      startedAt,
      ...(input.sha === undefined ? {} : { sha: input.sha }),
      instanceId: randomBytes(12).toString("hex"),
      lastRequestAt: startedAt,
      token,
      dbPath: child.dbPath ?? "",
      process: child,
    };
    this.previews.set(id, preview);
    this.release(id);
    const {
      dbPath: _dbPath,
      process: _process,
      lastRequestAt: _lastRequestAt,
      token: _token,
      ...view
    } = preview;
    return view;
  }

  touch(pr: number, repoId?: string): boolean {
    const preview = this.previews.get(this.key(pr, repoId));
    if (!preview) return false;
    preview.lastRequestAt = this.now();
    return true;
  }

  /** The child proves it owns this preview with its per-preview activity token. */
  activity(pr: number, token: string, repoId?: string): boolean {
    const preview = this.previews.get(this.key(pr, repoId));
    if (!preview || preview.token !== token) return false;
    preview.lastRequestAt = this.now();
    return true;
  }

  async expire(): Promise<void> {
    const cutoff = this.now() - PREVIEW_IDLE_MS;
    await Promise.all(
      [...this.previews.values()]
        .filter((preview) => preview.lastRequestAt < cutoff)
        .map((preview) => this.close(preview.pr, preview.repoId)),
    );
  }

  async close(pr: number, repoId?: string): Promise<boolean> {
    return await this.closeKey(this.key(pr, repoId));
  }

  private async closeKey(pr: string): Promise<boolean> {
    const pending = this.pending.get(pr);
    if (pending) {
      pending.controller.abort();
      await pending.done;
      // start() may have published the child between its dependency resolving and our abort.
      // In that case this close still owns the requested teardown.
      if (this.previews.has(pr)) await this.closeKey(pr);
      return true;
    }
    const preview = this.previews.get(pr);
    if (!preview) return false;
    this.previews.delete(pr);
    await preview.process.stop();
    if (preview.dbPath !== "") await this.deps.remove(preview.dbPath);
    return true;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.pending.values()];
    for (const preview of pending) preview.controller.abort();
    await Promise.all(pending.map((preview) => preview.done));
    await Promise.all([...this.previews.keys()].map((id) => this.closeKey(id)));
  }

  private portInUse(port: number): boolean {
    return (
      [...this.previews.values()].some((preview) => preview.port === port) ||
      [...this.pending.values()].some((preview) => preview.port === port)
    );
  }

  private async reserve(pr: string): Promise<PendingPreview> {
    let release: () => void = () => {};
    const previous = this.reservations;
    this.reservations = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      if (this.previews.has(pr) || this.pending.has(pr))
        throw new PreviewHubError("already-running", "a preview is already running for this PR");
      const capacity = this.deps.capacity();
      if (capacity.blocked)
        throw new PreviewHubError(
          "capacity",
          `machine headroom is tight: ${capacity.reason ?? "preview starts are paused"}`,
        );
      if (this.previews.size + this.pending.size >= PREVIEW_LIMIT)
        throw new PreviewHubError("limit", `at most ${PREVIEW_LIMIT} previews can run at once`);
      const port = await this.freePort();
      if (port === undefined) throw new PreviewHubError("no-port", "no preview port is available");
      let resolve: () => void = () => {};
      const pending: PendingPreview = {
        port,
        controller: new AbortController(),
        done: new Promise<void>((done) => (resolve = done)),
        resolve,
      };
      this.pending.set(pr, pending);
      return pending;
    } finally {
      release();
    }
  }

  private release(pr: string): void {
    const pending = this.pending.get(pr);
    this.pending.delete(pr);
    pending?.resolve();
  }

  private async freePort(): Promise<number | undefined> {
    for (const port of PREVIEW_PORTS) {
      if (!this.portInUse(port) && !(await this.deps.exists(port))) return port;
    }
    return undefined;
  }
}
