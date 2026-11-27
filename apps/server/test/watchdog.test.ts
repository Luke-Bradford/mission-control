import { describe, expect, it, vi } from "vitest";
import {
  HUB_WATCHDOG_RESTART_SETTING,
  WATCHDOG_EXIT_GAP_MS,
  WATCHDOG_FAILURE_MS,
  createHubWatchdog,
} from "../src/watchdog.ts";

describe("hub watchdog", () => {
  it("records a persistent spawn failure, exits after five minutes, and limits exits to one an hour", async () => {
    let now = 0;
    const events: string[] = [];
    const settings = new Map<string, string>();
    const exit = vi.fn();
    const watchdog = createHubWatchdog({
      now: () => now,
      probe: async () => ({ openFiles: 12, limit: 100, folders: ["/tmp (12)"] , error: "spawn EBADF" }),
      event: (text) => events.push(text),
      notice: (text) => events.push(`notice: ${text}`),
      setting: (key) => settings.get(key) ?? null,
      setSetting: (key, value) => settings.set(key, value),
      exit,
    });

    await watchdog.check();
    now = WATCHDOG_FAILURE_MS - 1;
    await watchdog.check();
    expect(exit).not.toHaveBeenCalled();

    now += 1;
    await watchdog.check();
    expect(exit).toHaveBeenCalledWith(1);
    expect(events.join("\n")).toContain("spawn check failed for 5 minutes: spawn EBADF");
    expect(settings.get(HUB_WATCHDOG_RESTART_SETTING)).toContain("spawn EBADF");

    now += WATCHDOG_FAILURE_MS;
    await watchdog.check();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(events.join("\n")).toContain("notice:");

    now += WATCHDOG_EXIT_GAP_MS;
    await watchdog.check();
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it("reports the latest failed spawn check for health", async () => {
    const watchdog = createHubWatchdog({
      now: () => 1,
      probe: async () => ({ openFiles: 1, limit: 100, folders: [], error: "spawn EBADF" }),
      event: () => {},
      notice: () => {},
      setting: () => null,
      setSetting: () => {},
      exit: () => {},
    });
    await watchdog.check();
    expect(watchdog.health()).toMatchObject({ collector: "watchdog", ok: false, error: "spawn EBADF" });
  });
});
