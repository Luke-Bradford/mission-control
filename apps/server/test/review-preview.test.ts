import { describe, expect, it, vi } from "vitest";
import { PreviewHubError } from "../src/previews.ts";
import { createReviewPreviews, isWebPr } from "../src/review-preview.ts";

const view = (pr: number) => ({
  pr,
  branch: `feature/${pr}`,
  port: 7431,
  url: "http://127.0.0.1:7431",
  startedAt: 1,
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
  const log = vi.fn();
  const previews = createReviewPreviews({
    previews: { start, close, get: () => over.running ?? null },
    files: () => over.files ?? ["apps/web/src/app.tsx"],
    webGlobs: async () => ["apps/web/**"],
    checkout: () => (over.checkout === undefined ? "/clone" : over.checkout),
    log,
  });
  return { previews, start, close, log };
}
const input = { runId: "retro:1", repoId: "mc", pr: 9, branch: "feature/9" };

describe("isWebPr", () => {
  it("matches any changed path under a web glob", () => {
    expect(isWebPr(["apps/server/a.ts", "apps/web/src/a.tsx"], ["apps/web/**"])).toBe(true);
    expect(isWebPr(["apps/server/a.ts"], ["apps/web/**"])).toBe(false);
    expect(isWebPr(["apps/web/a.ts"], [])).toBe(false);
  });
});

describe("createReviewPreviews", () => {
  it("opens a preview of a web PR's head and hands its URL to the run", async () => {
    const m = make();
    expect(await m.previews.open(input)).toEqual({ origin: "http://127.0.0.1:7431", note: null });
    expect(m.start).toHaveBeenCalledWith({ pr: 9, branch: "feature/9", checkout: "/clone" });
    expect(m.previews.origin("retro:1")).toBe("http://127.0.0.1:7431");
    expect(m.previews.origin("retro:2")).toBeNull();
  });

  it("starts nothing for a PR with no web files", async () => {
    const m = make({ files: ["apps/server/a.ts"] });
    expect(await m.previews.open(input)).toEqual({ origin: null, note: null });
    expect(m.start).not.toHaveBeenCalled();
  });

  it("reports why a preview did not start, so the review goes ahead without one", async () => {
    const m = make({
      start: async () => {
        throw new PreviewHubError("capacity", "machine headroom is tight: busy");
      },
    });
    expect(await m.previews.open(input)).toEqual({
      origin: null,
      note: "machine headroom is tight: busy",
    });
    expect(m.previews.origin("retro:1")).toBeNull();
    expect(m.log).toHaveBeenCalled();
  });

  it("closes the preview its run opened, once", async () => {
    const m = make();
    await m.previews.open(input);
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
    expect((await m.previews.open(input)).origin).toBe("http://127.0.0.1:7431");
    await m.previews.close("retro:1");
    expect(m.close).not.toHaveBeenCalled();
  });
});
