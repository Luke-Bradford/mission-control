import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOlderEvents } from "../src/shell/olderEvents.ts";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => vi.unstubAllGlobals());

const PATH = "/api/agents/flight-1/stream?limit=20";
const stream = (runId: string) => ({
  runId,
  truncated: false,
  lastOutputAt: null,
  reason: null,
  hasMore: true,
  events: [{ id: `${runId}:0`, at: 1, kind: "msg" as const, text: "hi" }],
});

describe("useOlderEvents", () => {
  it("drops a paging error when FLIGHT starts its next run", async () => {
    stubFetch({ [`${PATH}&before=r1%3A0`]: () => ({ status: 500, body: { error: "boom" } }) });
    const { result, rerender } = renderHook(({ live }) => useOlderEvents(PATH, live), {
      initialProps: { live: stream("r1") },
    });
    act(() => result.current.load());
    await waitFor(() => expect(result.current.error).toBe("Could not load older events."));
    rerender({ live: stream("r2") });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("ignores an older page that arrives after the run changed", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(new Response(JSON.stringify({ ...stream("r1"), events: [] }), { status: 500 }));
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { result, rerender } = renderHook(({ live }) => useOlderEvents(PATH, live), {
      initialProps: { live: stream("r1") },
    });
    act(() => result.current.load());
    rerender({ live: stream("r2") });
    await act(async () => {
      release?.();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
