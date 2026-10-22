import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tiles } from "../src/agent/Tiles.tsx";
import { hub, SEAT_CONTEXT_REFRESH_MS } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow, NOW } from "./fixtures.ts";

const PATH = "/api/seats/guido-1/context";
const OTHER = "/api/seats/guido-2/context";
const seat = (hudState: "running" | "stalled" | "idle", id = "guido-1") =>
  crewRow({ id, kind: "crew", loopKind: "crew", role: "GUIDO", hudState });

let f: ReturnType<typeof stubFetch>;
const fetches = (path = PATH) => f.mock.calls.filter((c) => c[0] === path).length;
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
  f = stubFetch({ [PATH]: null, [OTHER]: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a seat's Context tile", () => {
  it("fetches once for a burst of agents events, again after the refresh interval", async () => {
    render(<Tiles row={seat("running")} limits={[]} now={NOW} />);
    await flush();
    expect(fetches()).toBe(1);
    for (let i = 0; i < 20; i++) hub.refetchTopic("agents");
    await flush();
    expect(fetches()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(SEAT_CONTEXT_REFRESH_MS));
    expect(fetches()).toBe(2);
  });

  it("fetches once more when the turn ends, then stops asking", async () => {
    const view = render(<Tiles row={seat("running")} limits={[]} now={NOW} />);
    await flush();
    expect(fetches()).toBe(1);
    view.rerender(<Tiles row={seat("idle")} limits={[]} now={NOW} />);
    await flush();
    expect(fetches()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(3 * SEAT_CONTEXT_REFRESH_MS));
    expect(fetches()).toBe(2);
  });

  it("loads an idle seat's reading at mount and does not poll it", async () => {
    render(<Tiles row={seat("idle")} limits={[]} now={NOW} />);
    await flush();
    expect(fetches()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(3 * SEAT_CONTEXT_REFRESH_MS));
    expect(fetches()).toBe(1);
  });

  it("counts running to stalled as one turn: no extra fetch, polling continues", async () => {
    const view = render(<Tiles row={seat("running")} limits={[]} now={NOW} />);
    await flush();
    view.rerender(<Tiles row={seat("stalled")} limits={[]} now={NOW} />);
    await flush();
    expect(fetches()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(SEAT_CONTEXT_REFRESH_MS));
    expect(fetches()).toBe(2);
  });

  it("switching from a running seat to an idle one fetches the new seat once", async () => {
    const view = render(<Tiles row={seat("running")} limits={[]} now={NOW} />);
    await flush();
    view.rerender(<Tiles row={seat("idle", "guido-2")} limits={[]} now={NOW} />);
    await flush();
    expect(fetches(OTHER)).toBe(1);
    expect(fetches()).toBe(1);
  });
});
