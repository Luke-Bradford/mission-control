import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_IDLE_MS,
  PreviewHubError,
  PreviewManager,
  type PreviewStart,
} from "../src/previews.ts";
import { createReviewPreviews, isWebPr } from "../src/review-preview.ts";

const SHA = "a".repeat(40);
const view = (pr: number, startedAt = 1, sha = SHA) => ({
  sha,
  pr,
  branch: `feature/${pr}`,
  port: 7431,
  url: "http://127.0.0.1:7431",
  startedAt,
});

function make(
  over: {
    files?: string[];
    start?: (input: PreviewStart) => Promise<ReturnType<typeof view>>;
    running?: ReturnType<typeof view> | null;
    checkout?: string | null;
  } = {},
) {
  const start = vi.fn(over.start ?? (async (_input: PreviewStart) => view(9)));
  const close = vi.fn(async () => true);
  const touch = vi.fn(() => true);
  const log = vi.fn();
  let running = over.running ?? null;
  const previews = createReviewPreviews({
    previews: {
      start: async (input) => {
        const v = await start(input);
        running = v;
        return v;
      },
      close,
      touch,
      get: () => running,
    },
    files: () => over.files ?? ["apps/web/src/app.tsx"],
    webGlobs: async () => ["apps/web/**"],
    checkout: () => (over.checkout === undefined ? "/clone" : over.checkout),
    log,
  });
  return {
    previews,
    start,
    close,
    touch,
    log,
    stop: () => {
      running = null;
    },
  };
}
const input = { runId: "retro:1", repoId: "mc", pr: 9, branch: "feature/9", sha: SHA };

afterEach(() => vi.useRealTimers());

describe("isWebPr", () => {
  it("matches any changed path under a web glob", () => {
    expect(isWebPr(["apps/server/a.ts", "apps/web/src/a.tsx"], ["apps/web/**"])).toBe(true);
    expect(isWebPr(["apps/server/a.ts"], ["apps/web/**"])).toBe(false);
    expect(isWebPr(["apps/web/a.ts"], [])).toBe(false);
  });
});

describe("createReviewPreviews", () => {
  it("starts a preview of a web PR's head in the background and hands its URL to the run", async () => {
    const m = make();
    expect(await m.previews.open(input)).toBe(true);
    expect(await m.previews.ready("retro:1")).toEqual({
      origin: "http://127.0.0.1:7431",
      identity: expect.any(String),
      note: null,
    });
    expect(m.start).toHaveBeenCalledTimes(1);
    expect(m.previews.origin("retro:1")).toBe("http://127.0.0.1:7431");
    expect(m.previews.origin("retro:2")).toBeNull();
  });

  it("passes the immutable review SHA to the preview build", async () => {
    const m = make();
    await m.previews.open(input);
    await m.previews.ready(input.runId);
    expect(m.start).toHaveBeenCalledWith(
      expect.objectContaining({ sha: SHA, signal: expect.any(AbortSignal) }),
    );
    await m.previews.close(input.runId);
  });

  it("refuses an operator preview of an older head and leaves it running", async () => {
    const m = make({
      running: view(9, 1, "b".repeat(40)),
      start: async () => {
        throw new PreviewHubError("already-running", "already running");
      },
    });
    await m.previews.open(input);
    expect(await m.previews.ready(input.runId)).toMatchObject({
      origin: null,
      note: expect.stringContaining("different or unknown head"),
    });
    await m.previews.close(input.runId);
    expect(m.close).not.toHaveBeenCalled();
  });

  it("immediate review cancellation does not close an operator-owned preview", async () => {
    const stop = vi.fn();
    const manager = new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      start: async () => ({ stop }),
      remove: async () => {},
    });
    await manager.start({ pr: 9, branch: input.branch, checkout: "/clone", sha: SHA });
    const reviews = createReviewPreviews({
      previews: manager,
      files: () => ["apps/web/a.tsx"],
      webGlobs: async () => ["apps/web/**"],
      checkout: () => "/clone",
    });
    await reviews.open(input);
    await reviews.close(input.runId);
    expect(manager.get(9)?.sha).toBe(SHA);
    expect(stop).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it("cancels only its own pending build", async () => {
    let signal: AbortSignal | undefined;
    const manager = new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      start: async (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
        }),
      remove: async () => {},
    });
    const reviews = createReviewPreviews({
      previews: manager,
      files: () => ["apps/web/a.tsx"],
      webGlobs: async () => ["apps/web/**"],
      checkout: () => "/clone",
    });
    await reviews.open(input);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await reviews.close(input.runId);
    expect(signal?.aborted).toBe(true);
    expect(manager.list()).toEqual([]);
  });

  it("does not wait for the build when it opens", async () => {
    const m = make({ start: () => new Promise(() => {}) });
    expect(await m.previews.open(input)).toBe(true);
  });

  it("starts nothing for a PR with no web files", async () => {
    const m = make({ files: ["apps/server/a.ts"] });
    expect(await m.previews.open(input)).toBe(false);
    expect(m.start).not.toHaveBeenCalled();
    expect(await m.previews.ready("retro:1")).toEqual({ origin: null, note: null, identity: null });
  });

  it("reports why a preview did not start, so the review goes ahead without one", async () => {
    const m = make({
      start: async () => {
        throw new PreviewHubError("capacity", "machine headroom is tight: busy");
      },
    });
    await m.previews.open(input);
    expect(await m.previews.ready("retro:1")).toEqual({
      origin: null,
      identity: null,
      note: "machine headroom is tight: busy",
    });
    expect(m.log).toHaveBeenCalled();
  });

  it("closes the preview its run started, once", async () => {
    const m = make();
    await m.previews.open(input);
    await m.previews.ready("retro:1");
    await m.previews.close("retro:1");
    await m.previews.close("retro:1");
    expect(m.close).toHaveBeenCalledTimes(1);
    expect(m.close).toHaveBeenCalledWith(9);
    expect(m.previews.origin("retro:1")).toBeNull();
  });

  it("uses a preview the operator already started, and leaves it running", async () => {
    const m = make({
      start: async () => {
        throw new PreviewHubError("already-running", "a preview is already running for this PR");
      },
      running: view(9),
    });
    await m.previews.open(input);
    expect((await m.previews.ready("retro:1")).origin).toBe("http://127.0.0.1:7431");
    await m.previews.close("retro:1");
    expect(m.close).not.toHaveBeenCalled();
  });

  it("stops using a preview that has gone, and does not close it again", async () => {
    const m = make();
    await m.previews.open(input);
    await m.previews.ready("retro:1");
    m.stop();
    expect(m.previews.origin("retro:1")).toBeNull();
    expect((await m.previews.ready("retro:1")).note).toBe("the preview is no longer running");
    await m.previews.close("retro:1");
    expect(m.close).not.toHaveBeenCalled();
  });

  it("keeps the preview alive past the manager's idle expiry while the run is open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const manager = new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      start: async () => ({ stop: () => {} }),
      remove: async () => {},
    });
    const rp = createReviewPreviews({
      previews: manager,
      files: () => ["apps/web/a.tsx"],
      webGlobs: async () => ["apps/web/**"],
      checkout: () => "/clone",
    });
    await rp.open(input);
    const { origin } = await rp.ready("retro:1");
    expect(origin).not.toBeNull();
    vi.advanceTimersByTime(PREVIEW_IDLE_MS + 60_000);
    await manager.expire();
    expect(manager.get(9)).not.toBeNull();
    expect(rp.origin("retro:1")).toBe(origin);
    await rp.close("retro:1");
    expect(manager.get(9)).toBeNull();
  });
});
