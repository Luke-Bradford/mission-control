import type { Crew } from "@mc/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PauseButton, STUDIO_PAUSE_TOOLTIP } from "../src/components/PauseButton.tsx";
import { RESOURCES, useResource } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow } from "./fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Keeps `/api/crew` on screen, so a refetch of it actually goes out. */
function CrewProbe() {
  useResource<Crew>(RESOURCES.crew);
  return null;
}

const crewFetches = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.filter(([url]) => url === "/api/crew?shape=summary").length;

describe("PauseButton", () => {
  it("shows the server's text for a 503, and refetches the crew", async () => {
    const fetch = stubFetch({
      "/api/crew?shape=summary": { rows: [], firstRunToday: null },
      "POST /api/agents/shop-app-ta/pause": () => ({
        status: 503,
        body: { error: "could not update pause state" },
      }),
    });
    render(
      <>
        <CrewProbe />
        <PauseButton row={crewRow()} />
      </>,
    );
    await vi.waitFor(() => expect(crewFetches(fetch)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    expect(await screen.findByText("could not update pause state")).toBeTruthy();
    expect((screen.getByRole("button", { name: "pause" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await vi.waitFor(() => expect(crewFetches(fetch)).toBe(2));
  });

  it("shows the server's own text for a 409 (the preview guard), and refetches the crew", async () => {
    const fetch = stubFetch({
      "/api/crew?shape=summary": { rows: [], firstRunToday: null },
      "POST /api/agents/shop-app-ta/pause": () => ({
        status: 409,
        body: { error: "loop writes are disabled on this server" },
      }),
    });
    render(
      <>
        <CrewProbe />
        <PauseButton row={crewRow()} />
      </>,
    );
    await vi.waitFor(() => expect(crewFetches(fetch)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    expect(await screen.findByText("loop writes are disabled on this server")).toBeTruthy();
    expect(screen.queryByText(STUDIO_PAUSE_TOOLTIP)).toBeNull();
    expect((screen.getByRole("button", { name: "pause" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await vi.waitFor(() => expect(crewFetches(fetch)).toBe(2));
  });

  it("an unreachable server says so, and refetches the crew", async () => {
    let calls = 0;
    const fetch = vi.fn(async (url: string) => {
      calls++;
      if (url === "/api/crew?shape=summary") {
        return new Response(JSON.stringify({ rows: [], firstRunToday: null }), { status: 200 });
      }
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <>
        <CrewProbe />
        <PauseButton row={crewRow()} />
      </>,
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    expect(await screen.findByText("server unreachable")).toBeTruthy();
    await vi.waitFor(() =>
      expect(fetch.mock.calls.filter(([u]) => u === "/api/crew?shape=summary").length).toBe(2),
    );
  });

  it.each([
    [409, "loop writes are disabled on this server"],
    [503, "could not update pause state"],
  ])(
    "a resume the server refuses with %i shows its reason and re-enables the button",
    async (status, error) => {
      stubFetch({ "POST /api/agents/shop-app-ta/resume": () => ({ status, body: { error } }) });
      render(<PauseButton row={crewRow({ paused: true, hudState: "parked" })} />);
      fireEvent.click(screen.getByRole("button", { name: "resume" }));
      expect(await screen.findByText(error)).toBeTruthy();
      await vi.waitFor(() =>
        expect((screen.getByRole("button", { name: "resume" }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
    },
  );

  it("resumes a paused TA loop", async () => {
    const fetch = stubFetch({ "POST /api/agents/shop-app-ta/resume": { ok: true } });
    render(<PauseButton row={crewRow({ paused: true, hudState: "parked" })} />);
    const btn = screen.getByRole("button", { name: "resume" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/agents/shop-app-ta/resume",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("busies only its own agent's button, and a second click sends no second request", async () => {
    let release: () => void = () => {};
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response("{}", { status: 200 });
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <>
        <PauseButton row={crewRow({ id: "shop-app-ta" })} />
        <PauseButton row={crewRow({ id: "other-ta" })} />
      </>,
    );
    const [first, second] = screen.getAllByRole("button", { name: "pause" }) as HTMLButtonElement[];
    const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    fireEvent.click(first as HTMLButtonElement);
    fireEvent.click(first as HTMLButtonElement);
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(first?.disabled).toBe(true);
    expect(second?.disabled).toBe(false);
    fireEvent.click(second as HTMLButtonElement);
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map(([url]) => url)).toEqual([
      "/api/agents/shop-app-ta/pause",
      "/api/agents/other-ta/pause",
    ]);
    release();
  });

  it("is disabled for a studio loop, with the cutover tooltip", () => {
    const fetch = stubFetch({});
    render(<PauseButton row={crewRow({ id: "studio-builder", loopKind: "studio-loop" })} />);
    const btn = screen.getByRole("button", { name: "pause" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a disabled button's reason is reachable by keyboard: a focusable wrapper describes it", () => {
    stubFetch({});
    render(<PauseButton row={crewRow({ id: "studio-builder", loopKind: "studio-loop" })} />);
    const btn = screen.getByRole("button", { name: "pause" });
    const wrap = btn.parentElement as HTMLElement;
    expect(wrap.tabIndex).toBe(0);
    wrap.focus();
    expect(document.activeElement).toBe(wrap);
    expect(wrap.title).toBe(STUDIO_PAUSE_TOOLTIP);
    const reason = document.getElementById(wrap.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(STUDIO_PAUSE_TOOLTIP);
    expect(btn.title).toBe(""); // one tooltip, not two
  });

  it("an enabled button needs no wrapper", () => {
    stubFetch({});
    render(<PauseButton row={crewRow()} />);
    expect(screen.getByRole("button", { name: "pause" }).parentElement?.tabIndex).toBe(-1);
  });
});
