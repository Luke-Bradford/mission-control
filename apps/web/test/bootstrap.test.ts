import { OPERATOR_BOOTSTRAP_PATH } from "@mc/core";
import { afterEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { startClient } from "../src/bootstrap.ts";
import { hub, RESOURCES } from "../src/data.ts";

afterEach(() => vi.unstubAllGlobals());

it("constructs EventSource before bootstrap and the first resource fetch without waiting for either", async () => {
  forgetOperatorToken();
  const calls: string[] = [];
  const close = vi.fn();
  class Source {
    constructor(path: string) {
      calls.push(path);
    }
    addEventListener() {}
    close = close;
  }
  vi.stubGlobal("EventSource", Source);
  const finish: (() => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      calls.push(path);
      return new Promise<Response>((resolve) => finish.push(() => resolve(Response.json({}))));
    }),
  );
  let unsubscribe = () => {};
  const stop = startClient(() => {
    unsubscribe = hub.subscribe(RESOURCES.crew.path, RESOURCES.crew.topic, () => {});
  });
  try {
    expect(calls).toEqual(["/api/stream", OPERATOR_BOOTSTRAP_PATH, RESOURCES.crew.path]);
  } finally {
    unsubscribe();
    stop();
    for (const resolve of finish) resolve();
    await Promise.all(vi.mocked(fetch).mock.results.map((result) => result.value));
  }
  expect(close).toHaveBeenCalledOnce();
});
