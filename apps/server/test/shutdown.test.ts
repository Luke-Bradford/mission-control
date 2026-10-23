import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSignal, SHUTDOWN_TIMEOUT_MS } from "../src/shutdown.ts";

function harness(
  stop: () => Promise<void>,
  close: () => Promise<void> = async () => {},
  stopCrew: () => Promise<void> = async () => {},
  drain: (calls: string[]) => Promise<void> = async () => {},
) {
  const calls: string[] = [];
  const log = {
    info: vi.fn((m: string) => calls.push(`info ${m}`)),
    warn: vi.fn((m: string) => calls.push(`warn ${m}`)),
  };
  const exit = vi.fn((code: number) => calls.push(`exit ${code}`));
  const shutdown = onSignal({
    drain: () => drain(calls),
    stopCrew: async () => {
      calls.push("stopCrew");
      await stopCrew();
    },
    stop: async () => {
      calls.push("stop");
      await stop();
    },
    close: async () => {
      calls.push("close");
      await close();
    },
    log,
    exit,
  });
  return { calls, log, exit, shutdown };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onSignal", () => {
  it("stops the crew, then the scheduler, closes the server, then exits 0", async () => {
    const h = harness(async () => {});
    await h.shutdown("SIGTERM");
    expect(h.calls).toEqual(["info SIGTERM: shutting down", "stopCrew", "stop", "close", "exit 0"]);
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it(`exits 0 with a warning when stopping takes longer than ${SHUTDOWN_TIMEOUT_MS} ms`, async () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    const h = harness(() => new Promise<void>(() => {})); // a stop that never finishes
    void h.shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn.mock.calls[0]?.[0]).toMatch(/10000 ms/);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("bounds a server close that hangs, too", async () => {
    const h = harness(
      async () => {},
      () => new Promise<void>(() => {}),
    );
    void h.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    expect(h.calls).toEqual([
      "info SIGTERM: shutting down",
      "stopCrew",
      "stop",
      "close",
      expect.stringMatching(/^warn /),
      "exit 0",
    ]);
  });

  it("bounds a crew stop that hangs, too", async () => {
    const h = harness(
      async () => {},
      async () => {},
      () => new Promise<void>(() => {}),
    );
    void h.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    expect(h.calls).toEqual([
      "info SIGTERM: shutting down",
      "stopCrew",
      expect.stringMatching(/^warn /),
      "exit 0",
    ]);
  });

  it("drains in-flight mc calls before stopping the crew", async () => {
    let finishCall: () => void = () => {};
    const h = harness(
      async () => {},
      async () => {},
      async () => {},
      async (calls) => {
        calls.push("drain start");
        await new Promise<void>((r) => {
          finishCall = r;
        });
        calls.push("drain end");
      },
    );
    const done = h.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toEqual(["info SIGTERM: shutting down", "drain start"]);
    finishCall();
    await done;
    expect(h.calls).toEqual([
      "info SIGTERM: shutting down",
      "drain start",
      "drain end",
      "stopCrew",
      "stop",
      "close",
      "exit 0",
    ]);
  });

  it("exits within the limit when an mc call never ends", async () => {
    const h = harness(
      async () => {},
      async () => {},
      async () => {},
      () => new Promise<void>(() => {}), // a call that never ends
    );
    void h.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    expect(h.calls).toEqual([
      "info SIGTERM: shutting down",
      expect.stringMatching(/^warn /),
      "exit 0",
    ]);
  });

  it("ignores a second signal while shutting down", async () => {
    const h = harness(async () => {});
    await Promise.all([h.shutdown("SIGTERM"), h.shutdown("SIGINT")]);
    expect(h.calls.filter((c) => c === "stop")).toHaveLength(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});
