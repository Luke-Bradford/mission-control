import { describe, expect, it, vi } from "vitest";
import {
  PREVIEW_IDLE_MS,
  PreviewHubError,
  PreviewManager,
  type PreviewProcess,
} from "../src/previews.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");

describe("PreviewManager", () => {
  it("reserves distinct ports while concurrent starts are still preparing", async () => {
    let release: (() => void) | undefined;
    const preparing = new Promise<void>((resolve) => (release = resolve));
    const manager = new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      start: async () => {
        await preparing;
        return { stop: () => {} };
      },
      remove: async () => {},
    });

    const first = manager.start({ pr: 41, branch: "feature/41", checkout: "/repo" });
    const second = manager.start({ pr: 42, branch: "feature/42", checkout: "/repo" });
    await expect(
      manager.start({ pr: 43, branch: "feature/43", checkout: "/repo" }),
    ).rejects.toMatchObject({
      code: "limit",
    });
    release?.();
    expect((await Promise.all([first, second])).map((preview) => preview.port)).toEqual([
      7431, 7432,
    ]);
  });

  it("cancels and waits for a preview still preparing during shutdown", async () => {
    let cleaned = false;
    const manager = new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      start: async ({ signal }) =>
        await new Promise<PreviewProcess>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            cleaned = true;
            reject(new Error("cancelled"));
          });
        }),
      remove: async () => {},
    });
    const starting = manager.start({ pr: 41, branch: "feature/41", checkout: "/repo" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.closeAll();
    await expect(starting).rejects.toThrow("cancelled");
    expect(cleaned).toBe(true);
  });

  it("uses the spare-port pool, refuses a third preview, and releases a closed port", async () => {
    let clock = NOW;
    const starts: { port: number; dbPath: string; token: string }[] = [];
    const manager = new PreviewManager({
      now: () => clock,
      capacity: () => ({ blocked: false, reason: null }),
      exists: (port) => port === 7431,
      start: async ({ port, token }) => {
        starts.push({ port, dbPath: "", token });
        return { stop: vi.fn() };
      },
      remove: vi.fn(async () => {}),
    });

    await manager.start({ pr: 41, branch: "feature/41", checkout: "/repo" });
    await manager.start({ pr: 42, branch: "feature/42", checkout: "/repo" });
    await expect(
      manager.start({ pr: 43, branch: "feature/43", checkout: "/repo" }),
    ).rejects.toMatchObject({
      code: "limit",
    });

    expect(starts.map((s) => s.port)).toEqual([7432, 7433]);
    expect(starts[0]?.token).not.toBe(starts[1]?.token);
    await manager.close(41);
    expect(manager.list().map((p) => p.pr)).toEqual([42]);
    clock += 1;
    await manager.start({ pr: 43, branch: "feature/43", checkout: "/repo" });
    expect(starts.at(-1)?.port).toBe(7432);
  });

  it("refuses while machine capacity is held and tears down idle previews", async () => {
    let clock = NOW;
    let held = true;
    let activityToken = "";
    const process: PreviewProcess & { dbPath: string } = {
      stop: vi.fn(),
      dbPath: "/tmp/preview.sqlite",
    };
    const remove = vi.fn(async () => {});
    const manager = new PreviewManager({
      now: () => clock,
      capacity: () => ({ blocked: held, reason: "memory free is 8.0%" }),
      exists: () => false,
      start: async ({ token }) => {
        activityToken = token;
        return process;
      },
      remove,
    });

    await expect(
      manager.start({ pr: 41, branch: "feature/41", checkout: "/repo" }),
    ).rejects.toEqual(
      new PreviewHubError("capacity", "machine headroom is tight: memory free is 8.0%"),
    );
    held = false;
    await manager.start({ pr: 41, branch: "feature/41", checkout: "/repo" });
    clock += PREVIEW_IDLE_MS - 1;
    expect(manager.activity(41, "wrong")).toBe(false);
    expect(manager.activity(41, activityToken)).toBe(true);
    clock += PREVIEW_IDLE_MS - 1;
    await manager.expire();
    expect(manager.list()).toHaveLength(1);
    clock += 2;
    await manager.expire();
    expect(process.stop).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});
