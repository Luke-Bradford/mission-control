import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub, streamStatus } from "../src/data.ts";
import { FLIGHT_STOPPED_NOTICE } from "../src/flight/flightTypes.ts";
import { FlightThread } from "../src/flight/FlightThread.tsx";
import { stubFetch } from "./fetchStub.ts";
import { NOW, seatRow } from "./fixtures.ts";

const seat = (live: boolean) => ({
  seat: { id: "flight-1", live, state: live ? "idle" : "stopped", model: "m", turns: null },
  decisions: [],
});
const msg = (id: string, text: string, operator = false) => ({
  id,
  from: operator ? "CAPCOM" : "flight-1",
  to: operator ? "flight-1" : "CAPCOM",
  text,
  at: NOW,
  operator,
});

function stub(messages: unknown[], live = true, post?: () => { status: number; body: unknown }) {
  return stubFetch({
    "/api/comms/flight": { messages, hasMore: false },
    "/api/flight": seat(live),
    "/api/crew?shape=summary": { rows: [seatRow()] },
    "POST /api/comms": post ?? (() => ({ status: 200, body: { state: "stored" } })),
  });
}

beforeEach(() => {
  streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  hub.clear();
});

describe("FlightThread", () => {
  it("says there are no messages yet", async () => {
    stub([]);
    render(<FlightThread />);
    expect(await screen.findByText("No messages yet.")).toBeTruthy();
  });

  it("shows FLIGHT's Markdown as formatted text with ticket links", async () => {
    stub([msg("comms:1", "**Done** - see #12\n\n- one\n- two")]);
    const { container } = render(<FlightThread />);
    await screen.findByText("Done");
    expect(container.textContent).not.toContain("**");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("takes text while FLIGHT is stopped and says it reads it when it starts", async () => {
    stub([], false);
    render(<FlightThread />);
    expect(await screen.findByText(FLIGHT_STOPPED_NOTICE)).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message FLIGHT" }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Start FLIGHT" })).toBeTruthy();
  });

  it("sends on Enter and breaks the line on Shift+Enter", async () => {
    const fn = stub([]);
    render(<FlightThread />);
    const box = (await screen.findByRole("textbox", { name: "Message FLIGHT" })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fn.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => {
      const post = fn.mock.calls.find(([p, i]) => p === "/api/comms" && i?.method === "POST");
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ to: "flight-1", text: "hello" });
    });
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("shows the server's text and Retry when a send fails", async () => {
    stub([], true, () => ({ status: 500, body: { error: "Hub is down" } }));
    render(<FlightThread />);
    const box = await screen.findByRole("textbox", { name: "Message FLIGHT" });
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/Hub is down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("hi");
  });

  it("shows the working line only when the server reports it", async () => {
    stubFetch({
      "/api/comms/flight": {
        messages: [],
        hasMore: false,
        flight: { live: true, since: Date.UTC(2026, 10, 14, 9, 5), runId: "r" },
      },
      "/api/flight": seat(true),
    });
    render(<FlightThread />);
    expect(await screen.findByText("FLIGHT is working… since 09:05")).toBeTruthy();
  });

  it("shows no working line when the server omits it", async () => {
    stub([msg("comms:1", "hi")]);
    render(<FlightThread />);
    await screen.findByText("hi");
    expect(screen.queryByText(/is working/)).toBeNull();
  });
});

describe("FlightThread on two surfaces", () => {
  it("shows a message sent from one mount in the other without a reload", async () => {
    let stored: unknown[] = [];
    stubFetch({
      "/api/comms/flight": () => ({ status: 200, body: { messages: stored, hasMore: false } }),
      "/api/flight": seat(true),
      "POST /api/comms": () => {
        stored = [msg("comms:9", "from the fly-out", true)];
        return { status: 200, body: { state: "stored" } };
      },
    });
    render(
      <>
        <section aria-label="fly-out">
          <FlightThread id="dockInput" />
        </section>
        <section aria-label="comms">
          <FlightThread />
        </section>
      </>,
    );
    const boxes = await screen.findAllByRole("textbox", { name: "Message FLIGHT" });
    await waitFor(() => expect((boxes[0] as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(boxes[0] as HTMLElement, { target: { value: "from the fly-out" } });
    fireEvent.keyDown(boxes[0] as HTMLElement, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("from the fly-out")).toHaveLength(2));
  });
});
