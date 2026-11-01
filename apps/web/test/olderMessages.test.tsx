import type { CommsMessage } from "@mc/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOlderMessages } from "../src/comms/older.ts";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => vi.unstubAllGlobals());

const PATH = "/api/comms/crew";
const msg = (n: number): CommsMessage => ({
  id: `m${n}`,
  at: n,
  from: "alpha",
  to: "crew",
  text: `m${n}`,
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  pinned: false,
  operator: false,
});
const page = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

describe("useOlderMessages", () => {
  it("keeps messages that slide out of the newest page once older ones are loaded", async () => {
    stubFetch({ [`${PATH}?before=m4`]: { messages: page(1, 3), hasMore: false } });
    const { result, rerender } = renderHook(
      ({ live }) => useOlderMessages(PATH, live, true, "messages"),
      { initialProps: { live: page(4, 6) } },
    );
    act(() => result.current.load());
    await waitFor(() => expect(result.current.messages).toHaveLength(6));
    rerender({ live: page(5, 7) });
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
    expect(result.current.hasMore).toBe(false);
  });
});
