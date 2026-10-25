import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePsLine, processInfo } from "../src/runtime/keeper.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("keeper process timestamps", () => {
  it.each(["Europe/London", "America/New_York", "UTC"])(
    "reads UTC lstart independently of the keeper's timezone: %s",
    (tz) => {
      vi.stubEnv("TZ", tz);
      const command = "/usr/bin/node keeper-cli.ts /run/k1";
      vi.mocked(execFileSync).mockReturnValue(`Sun Oct 25 01:08:41 2026 ${command}\n`);
      const info = processInfo(123);
      expect(execFileSync).toHaveBeenLastCalledWith(
        "ps",
        ["-ww", "-o", "lstart=,command=", "-p", "123"],
        expect.objectContaining({ env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }) }),
      );
      expect(info).toEqual({ startedAt: Date.UTC(2026, 9, 25, 1, 8, 41), command });
      // The repeated local hour must not make a reused pid look older than its pid file.
      const writtenBeforeStart = Date.UTC(2026, 9, 25, 1, 7, 41);
      expect(info?.startedAt).toBeGreaterThan(writtenBeforeStart);
      expect(info?.startedAt).toBeLessThanOrEqual(Date.UTC(2026, 9, 25, 1, 8, 42));
    },
  );

  it("keeps both occurrences of the repeated hour distinct", () => {
    vi.stubEnv("TZ", "Europe/London");
    const first = parsePsLine("Sun Oct 25 00:08:41 2026 node seat");
    const second = parsePsLine("Sun Oct 25 01:08:41 2026 node seat");
    expect(first?.startedAt).toBe(Date.UTC(2026, 9, 25, 0, 8, 41));
    expect(second?.startedAt).toBe(Date.UTC(2026, 9, 25, 1, 8, 41));
  });

  it("returns unknown when ps cannot identify the process", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("ps failed");
    });
    expect(processInfo(123)).toBeNull();
    vi.mocked(execFileSync).mockReturnValue("not a ps line");
    expect(processInfo(123)).toBeNull();
  });
});
