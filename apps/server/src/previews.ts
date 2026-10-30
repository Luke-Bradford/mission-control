import { randomBytes } from "node:crypto";

/** The ports reserved for branch preview hubs. */
export const PREVIEW_PORTS = [7431, 7432, 7433, 7434, 7435, 7436, 7437, 7438, 7439] as const;
export const PREVIEW_LIMIT = 2;
export const PREVIEW_IDLE_MS = 20 * 60_000;
export const PREVIEW_ACTIVITY_HEADER = "x-mc-preview-activity";

export type PreviewErrorCode = "capacity" | "limit" | "already-running" | "no-port";

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
  pr: number;
  branch: string;
  checkout: string;
}

export interface PreviewView {
  pr: number;
  branch: string;
  port: number;
  url: string;
  startedAt: number;
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
  /** Whether another local listener owns this candidate port. */
  exists(port: number): boolean | Promise<boolean>;
  capacity(): { blocked: boolean; reason: string | null };
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
  private readonly previews = new Map<number, Preview>();
  /** Starts reserve a PR and port before asynchronous checkout preparation begins. */
  private readonly pending = new Map<number, PendingPreview>();
  private reservations: Promise<void> = Promise.resolve();
  private readonly deps: PreviewManagerDeps;

  constructor(deps: PreviewManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
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

  get(pr: number): PreviewView | null {
    return this.list().find((preview) => preview.pr === pr) ?? null;
  }

  async start(input: PreviewStart): Promise<PreviewView> {
    const pending = await this.reserve(input.pr);
    const { port } = pending;
    const startedAt = this.now();
    const token = randomBytes(32).toString("base64url");
    let child: PreviewProcess & { dbPath?: string };
    try {
      child = await this.deps.start({ ...input, port, token, signal: pending.controller.signal });
    } catch (e) {
      this.release(input.pr);
      throw e;
    }
    const preview: Preview = {
      pr: input.pr,
      branch: input.branch,
      port,
      url: `http://127.0.0.1:${port}`,
      startedAt,
      lastRequestAt: startedAt,
      token,
      dbPath: child.dbPath ?? "",
      process: child,
    };
    this.release(input.pr);
    this.previews.set(input.pr, preview);
    const {
      dbPath: _dbPath,
      process: _process,
      lastRequestAt: _lastRequestAt,
      token: _token,
      ...view
    } = preview;
    return view;
  }

  touch(pr: number): boolean {
    const preview = this.previews.get(pr);
    if (!preview) return false;
    preview.lastRequestAt = this.now();
    return true;
  }

  /** The child proves it owns this preview with its per-preview activity token. */
  activity(pr: number, token: string): boolean {
    const preview = this.previews.get(pr);
    if (!preview || preview.token !== token) return false;
    preview.lastRequestAt = this.now();
    return true;
  }

  async expire(): Promise<void> {
    const cutoff = this.now() - PREVIEW_IDLE_MS;
    await Promise.all(
      [...this.previews.values()]
        .filter((preview) => preview.lastRequestAt < cutoff)
        .map((preview) => this.close(preview.pr)),
    );
  }

  async close(pr: number): Promise<boolean> {
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
    await Promise.all([...this.previews.keys()].map((pr) => this.close(pr)));
  }

  private portInUse(port: number): boolean {
    return (
      [...this.previews.values()].some((preview) => preview.port === port) ||
      [...this.pending.values()].some((preview) => preview.port === port)
    );
  }

  private async reserve(pr: number): Promise<PendingPreview> {
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

  private release(pr: number): void {
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
