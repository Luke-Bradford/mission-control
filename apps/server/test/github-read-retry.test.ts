import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWaitedPrs, makeGql } from "../src/collectors/github.ts";
import { makeRest, NOTIFICATIONS_URL } from "../src/collectors/notifications.ts";

import { Store } from "../src/store.ts";

const reset = () => new TypeError("private message", { cause: { code: "ECONNRESET" } });
const cutOff = (error: Error = reset()) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.error(error);
      },
    }),
  );

afterEach(() => vi.useRealTimers());

describe.each(["query", "notifications"])("%s read retry", (reader) => {
  const read = (f: typeof fetch) =>
    reader === "query"
      ? makeGql("secret", f)("query Read { x }", {})
      : makeRest("secret", f)(NOTIFICATIONS_URL, { "If-Modified-Since": "yesterday" });

  it.each(["headers", "body"])(
    "retries a dropped connection at %s once after one second",
    async (phase) => {
      vi.useFakeTimers();
      const f = vi.fn<typeof fetch>();
      if (phase === "headers") f.mockRejectedValueOnce(reset());
      else f.mockResolvedValueOnce(cutOff());
      f.mockResolvedValueOnce(new Response('{"data":{"x":1}}'));
      const result = read(f);
      await vi.advanceTimersByTimeAsync(999);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeDefined();
      expect(f).toHaveBeenCalledTimes(2);
      expect(f.mock.calls[1]?.[1]?.headers).toEqual(f.mock.calls[0]?.[1]?.headers);
    },
  );

  it("reports the second failure's cause without private text", async () => {
    vi.useFakeTimers();
    const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(reset())
      .mockRejectedValueOnce(new TypeError("secret", { cause: { code: "UND_ERR_SOCKET" } }));
    const result = read(f).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("github: request failed (UND_ERR_SOCKET)");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["UND_ERR_SOCKET", "github: response cut off (UND_ERR_SOCKET)"],
    [undefined, "github: response cut off"],
    ["private code text", "github: response cut off"],
  ])("reports only a safe body failure cause code: %s", async (code, expected) => {
    vi.useFakeTimers();
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cutOff())
      .mockResolvedValueOnce(cutOff(new TypeError("secret", { cause: { code } })));
    const result = read(f).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(expected);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("unrefs the one-second retry timer", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      const f = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(reset())
        .mockResolvedValueOnce(new Response('{"data":{"x":1}}'));
      const result = read(f);
      await vi.advanceTimersByTimeAsync(0);
      const index = timeout.mock.calls.findIndex((call) => call[1] === 1000);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(timeout.mock.results[index]?.value.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeDefined();
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["timeout", "body timeout", "http", "rate limit", "graphql"])(
    "does not retry %s",
    async (kind) => {
      vi.useFakeTimers();
      const f = vi.fn<typeof fetch>();
      if (kind === "timeout") f.mockRejectedValue(new DOMException("deadline", "TimeoutError"));
      else if (kind === "body timeout")
        f.mockImplementation(
          async () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.error(new DOMException("deadline", "TimeoutError"));
                },
              }),
            ),
        );
      else
        f.mockImplementation(
          async () =>
            new Response(kind === "graphql" ? '{"errors":[{"message":"failure"}]}' : "{}", {
              status: kind === "http" ? 503 : kind === "rate limit" ? 429 : 200,
            }),
        );
      await read(f).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f).toHaveBeenCalledTimes(1);
    },
  );
});

it.each(["headers", "body"])("never retries a mutation failing at %s", async (phase) => {
  vi.useFakeTimers();
  const f = vi.fn<typeof fetch>();
  if (phase === "headers") f.mockRejectedValue(reset());
  else f.mockImplementation(async () => cutOff());
  await expect(
    makeGql("secret", f)("mutation($input: Input!) { write(input: $input) }", {}),
  ).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f).toHaveBeenCalledTimes(1);
});

it.each(["headers", "body"])("records no collector failure after recovery at %s", async (phase) => {
  vi.useFakeTimers();
  const store = new Store(":memory:");
  try {
    const f = vi.fn<typeof fetch>();
    if (phase === "headers") f.mockRejectedValueOnce(reset());
    else f.mockResolvedValueOnce(cutOff());
    f.mockResolvedValueOnce(new Response('{"data":{"repository":{"pullRequest":null}}}'));
    const pending = collectWaitedPrs(
      { id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" },
      store,
      makeGql("secret", f),
      [1],
      () => 0,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(store.status()).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});
