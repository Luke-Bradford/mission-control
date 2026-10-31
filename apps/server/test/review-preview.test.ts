import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_IDLE_MS, PreviewHubError, PreviewManager } from "../src/previews.ts";
import { createReviewPreviews, isWebPr } from "../src/review-preview.ts";

const view = (pr: number, startedAt = 1) => ({
  pr,
  branch: `feature/${pr}`,
  port: 7431,
  url: "http://127.0.0.1:7431",
  startedAt,
});

function make(
  over: {
    files?: string[];
    start?: () => Promise<ReturnType<typeof view>>;
    running?: ReturnType<typeof view> | null;
    checkout?: string | null;
  } = {},
) {
  const start = vi.fn(over.start ?? (async () => view(9)));
  const close = vi.fn(async () => true);
  const touch = vi.fn(() => true);
  const log = vi.fn();
  let running = over.running ?? null;
  const previews = createReviewPreviews({
    previews: {
      start: async () => {
        const v = await start();
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
const input = { runId: "retro:1", repoId: "mc", pr: 9, branch: "feature/9" };

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
      note: null,
    });
    expect(m.start).toHaveBeenCalledTimes(1);
    expect(m.previews.origin("retro:1")).toBe("http://127.0.0.1:7431");
    expect(m.previews.origin("retro:2")).toBeNull();
  });

  it("does not wait for the build when it opens", async () => {
    const m = make({ start: () => new Promise(() => {}) });
    expect(await m.previews.open(input)).toBe(true);
  });

  it("starts nothing for a PR with no web files", async () => {
    const m = make({ files: ["apps/server/a.ts"] });
    expect(await m.previews.open(input)).toBe(false);
    expect(m.start).not.toHaveBeenCalled();
    expect(await m.previews.ready("retro:1")).toEqual({ origin: null, note: null });
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
