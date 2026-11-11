import type { AgentStream, CrewRow } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Agent } from "../src/pages/Agent.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { getSelectedAgent } from "../src/shell/selection.ts";
import { resetSession, setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { agentDraftKey, readKey } from "../src/storage.ts";
import { agentView } from "./agentV2Fixture.ts";
import { stubFetch } from "./fetchStub.ts";
import {
  boardItem,
  CREW_CONFIG,
  crewRow,
  MIN,
  NOW,
  SESSION_CONFIG,
  stoppedSeat,
} from "./fixtures.ts";

const stream = (over: Partial<AgentStream> = {}): AgentStream => ({
  runId: "r-12",
  events: [
    { id: "0:0", at: NOW - 2 * MIN, kind: "op", text: "Work on shop-app#3349" },
    { id: "1:0", at: NOW - MIN, kind: "think", text: "Checking the cache" },
    {
      id: "2:0",
      at: NOW - MIN / 2,
      kind: "tool",
      text: "Bash",
      tool: { name: "Bash", input: "pnpm test", result: "42 passed", ms: 10, error: false },
    },
  ],
  truncated: false,
  lastOutputAt: NOW - MIN,
  reason: null,
  ...over,
});

const seat = (over: Partial<CrewRow> = {}) =>
  crewRow({
    id: "guido-1",
    repoId: "shop-app",
    index: 2,
    kind: "crew",
    loopKind: "crew",
    role: "GUIDO",
    mode: "writer",
    area: ["apps/web/**"],
    model: "sonnet",
    sessionId: "s1",
    ...over,
  });

function stub(row = seat(), extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/crew?shape=summary": { rows: [row], firstRunToday: null },
    "/api/attention": [],
    "/api/limits": [],
    "/api/config": CREW_CONFIG,
    "/api/agents/guido-1": agentView(row),
    "/api/agents/guido-1/stream?limit=20": stream(),
    "/api/agents/guido-1/runs?limit=50": [],
    "/api/agents/guido-1/files": { files: [], note: null },
    "POST /api/seats/guido-1/message": { ok: true },
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetSession();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Agent control room", () => {
  it("shows the roster, identity band, reserved frames, and live activity", async () => {
    stub();
    const { container } = render(<Agent id="guido-1" />);
    await screen.findByText("Work on shop-app#3349");
    expect(container.querySelector(".agent-roster")).toBeTruthy();
    expect(container.querySelector(".agent-identity-band")).toBeTruthy();
    expect(container.querySelector(".agent-live-activity")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Reserved instruments" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Reserved right column" })).toBeTruthy();
    expect(screen.queryByText("Ask, result, next")).toBeNull();
    expect(screen.queryByText("Deliverables")).toBeNull();
  });

  it("shows Silent only for a running seat with no output for ten minutes", async () => {
    stub(seat({ hudState: "running", lastOutputAt: NOW - 10 * MIN }));
    render(<Agent id="guido-1" />);
    expect(await screen.findByText("Silent")).toBeTruthy();
    cleanup();
    stub(seat({ hudState: "running", lastOutputAt: NOW - 9 * MIN }));
    render(<Agent id="guido-1" />);
    await screen.findByText(/last output/);
    expect(screen.queryByText("Silent")).toBeNull();
    cleanup();
    stub(seat({ hudState: "idle", lastOutputAt: NOW - 30 * MIN, run: null }));
    render(<Agent id="guido-1" />);
    await screen.findByText(/last output/);
    expect(screen.queryByText("Silent")).toBeNull();
  });

  it("shows a stopped seat's reason, never Silent", async () => {
    const stopped = stoppedSeat({ id: "guido-1", repoId: "shop-app", note: "operator stopped it" });
    stub({ ...stopped, lastOutputAt: NOW - 30 * MIN });
    render(<Agent id="guido-1" />);
    expect(await screen.findByText("operator stopped it")).toBeTruthy();
    expect(screen.queryByText("Silent")).toBeNull();
  });

  it("puts the ticket and its title on the roster card, reachable by name", async () => {
    const title = "Rebuild the whole checkout flow so that a very long ticket title still reads";
    stub(seat({ ticket: "shop-app#3349", ticketTitle: title }));
    render(<Agent id="guido-1" />);
    const card = await screen.findByRole("button", { name: new RegExp(title) });
    expect(card.textContent).toContain(`shop-app#3349 ${title}`);
    expect(card.querySelector(".agent-roster-work")?.getAttribute("title")).toContain(title);
  });

  it("filters live activity and expands a tool row", async () => {
    stub();
    render(<Agent id="guido-1" />);
    await screen.findByText("Work on shop-app#3349");
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText("Bash")).toBeTruthy();
    fireEvent.click(screen.getByText("Bash"));
    expect((await screen.findAllByText(/42 passed/)).length).toBeGreaterThan(1);
  });

  it("keeps a typed message across a rerender", async () => {
    stub();
    const view = render(<Agent id="guido-1" />);
    const input = await screen.findByRole("textbox", { name: "Message this agent" });
    fireEvent.change(input, { target: { value: "Please check the guard." } });
    await waitFor(() => expect(readKey(agentDraftKey("guido-1"))).toBe("Please check the guard."));
    view.rerender(<Agent id="guido-1" />);
    expect(
      ((await screen.findByRole("textbox", { name: "Message this agent" })) as HTMLInputElement)
        .value,
    ).toBe("Please check the guard.");
  });

  it("shows sent then read only when the message route reports delivery", async () => {
    stub(seat(), {
      "POST /api/seats/guido-1/message": { ok: true, state: "delivered", deliveredAt: NOW },
    });
    render(<Agent id="guido-1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message this agent" }), {
      target: { value: "Please check the guard." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Message sent.")).toBeTruthy();
    vi.runOnlyPendingTimers();
    expect(await screen.findByText("Message read.")).toBeTruthy();
  });

  it("assigns Ready work, surfaces its receipt, and disables while a run is live", async () => {
    const f = stub(seat({ hudState: "idle", run: null }), {
      "/api/boards/shop-app": [boardItem({ issueNumber: 7, status: "Ready", state: "planned" })],
      "POST /api/seats/guido-1/start": { runId: "r-13" },
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign #7" }));
    expect(await screen.findByText("Assign confirmed.")).toBeTruthy();
    expect(f.mock.calls.some(([path]) => path === "/api/seats/guido-1/start")).toBe(true);
    cleanup();
    stub(seat(), {
      "/api/boards/shop-app": [boardItem({ issueNumber: 7, status: "Ready", state: "planned" })],
    });
    render(<Agent id="guido-1" />);
    expect(
      ((await screen.findByRole("button", { name: "Assign #7" })) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("confirms once for Stop and names action failures", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    stub(seat(), {
      "/api/boards/shop-app": [boardItem({ issueNumber: 7, status: "Ready", state: "planned" })],
      "POST /api/seats/guido-1/interrupt": { ok: true },
      "POST /api/seats/guido-1/end": { ok: true },
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));
    expect(await screen.findByText("Interrupt confirmed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stop confirmed.")).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(1);
    cleanup();
    stub(seat(), {
      "/api/boards/shop-app": [boardItem({ issueNumber: 7, status: "Ready", state: "planned" })],
      "POST /api/seats/guido-1/interrupt": () => ({ status: 409, body: { error: "seat is busy" } }),
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));
    expect(await screen.findByText("Interrupt failed: seat is busy")).toBeTruthy();
    confirm.mockRestore();
  });

  it.each(
    (["Interrupt", "Stop", "Assign"] as const).flatMap((action) =>
      ([true, false] as const).map((success) => ({ action, success })),
    ),
  )("names $action while pending and after success=$success", async ({ action, success }) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const row = action === "Assign" ? seat({ hudState: "idle", run: null }) : seat();
      const base = stub(row, {
        "/api/boards/shop-app": [boardItem({ issueNumber: 7, status: "Ready", state: "planned" })],
      });
      const path = `/api/seats/guido-1/${({ Interrupt: "interrupt", Stop: "end", Assign: "start" } as const)[action]}`;
      let finish: ((response: Response) => void) | undefined;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string, init?: RequestInit) =>
          input === path && init?.method === "POST" ? pending : base(input, init),
        ),
      );
      render(<Agent id="guido-1" />);
      const button = await screen.findByRole("button", {
        name: action === "Assign" ? "Assign #7" : action,
      });
      const stateBefore = document.querySelector(".agent-v2-state")?.textContent;
      fireEvent.click(button);
      expect(await screen.findByText(`${action} sent.`)).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(confirm).toHaveBeenCalledTimes(action === "Stop" ? 1 : 0);
      await act(async () => {
        finish?.(
          new Response(
            JSON.stringify(success ? { ok: true } : { error: "server refused action" }),
            { status: success ? 200 : 409 },
          ),
        );
        await pending;
      });
      expect(
        await screen.findByText(
          success ? `${action} confirmed.` : `${action} failed: server refused action`,
        ),
      ).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      if (!success)
        expect(document.querySelector(".agent-v2-state")?.textContent).toBe(stateBefore);
    } finally {
      confirm.mockRestore();
    }
  });

  it("keeps the chosen roster seat in the address", async () => {
    const other = seat({ id: "inco-2", index: 3, displayCallSign: "INCO-2" });
    stub(seat(), {
      "/api/crew?shape=summary": { rows: [seat(), other], firstRunToday: null },
      "/api/agents/inco-2": agentView(other),
      "/api/agents/inco-2/stream?limit=20": stream(),
    });
    render(<Agent id="guido-1" />);
    const roster = await screen.findByRole("complementary", { name: "Seat roster" });
    fireEvent.click(within(roster).getByRole("button", { name: /INCO-2/ }));
    expect(window.location.pathname).toBe("/agent/inco-2");
  });

  it("keeps a typed message after a refresh", async () => {
    stub();
    render(<Agent id="guido-1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message this agent" }), {
      target: { value: "Survive a reload." },
    });
    await waitFor(() => expect(readKey(agentDraftKey("guido-1"))).toBe("Survive a reload."));
    cleanup();
    stub();
    render(<Agent id="guido-1" />);
    expect(
      ((await screen.findByRole("textbox", { name: "Message this agent" })) as HTMLInputElement)
        .value,
    ).toBe("Survive a reload.");
  });

  it("keeps each seat's typed message apart when another seat is chosen", async () => {
    const other = seat({ id: "inco-2", index: 3, displayCallSign: "INCO-2" });
    const routes = {
      "/api/crew?shape=summary": { rows: [seat(), other], firstRunToday: null },
      "/api/agents/inco-2": agentView(other),
      "/api/agents/inco-2/stream?limit=20": stream(),
    };
    stub(seat(), routes);
    const view = render(<Agent id="guido-1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message this agent" }), {
      target: { value: "Carry me over." },
    });
    await waitFor(() => expect(readKey(agentDraftKey("guido-1"))).toBe("Carry me over."));
    const roster = screen.getByRole("complementary", { name: "Seat roster" });
    fireEvent.click(within(roster).getByRole("button", { name: /INCO-2/ }));
    view.rerender(<Agent id="inco-2" />);
    await screen.findByText("INCO-2", { selector: "h2, h2 *" }).catch(() => null);
    const box = () =>
      screen.getByRole("textbox", { name: "Message this agent" }) as HTMLInputElement;
    expect(box().value).toBe("");
    view.rerender(<Agent id="guido-1" />);
    expect(box().value).toBe("Carry me over.");
  });

  it("lists only the chosen session's seats and steps j and k within it", async () => {
    const mine = seat({ sessionId: "shop-app-session" });
    const mate = seat({
      id: "inco-2",
      index: 3,
      displayCallSign: "INCO-2",
      sessionId: "shop-app-session",
    });
    const away = seat({
      id: "inco-9",
      repoId: "site-builder",
      index: 4,
      displayCallSign: "INCO-9",
      sessionId: "site-builder-session",
    });
    stub(mine, {
      "/api/config": SESSION_CONFIG,
      "/api/crew?shape=summary": { rows: [mine, mate, away], firstRunToday: null },
      "/api/agents/inco-2": agentView(mate),
      "/api/agents/inco-2/stream?limit=20": stream(),
    });
    const off = installKeys({
      navigate: () => {},
      toggleDock: () => {},
      help: () => {},
      selectNext: () => {},
      selectPrev: () => {},
      toast: () => {},
    });
    onTestFinished(off);
    render(<Agent id="guido-1" />);
    await screen.findByText("Work on shop-app#3349");
    act(() => setSession("site-builder-session"));
    const roster = screen.getByRole("complementary", { name: "Seat roster" });
    await waitFor(() =>
      expect(within(roster).queryByRole("button", { name: /INCO-2/ })).toBeNull(),
    );
    expect(within(roster).getByRole("button", { name: /INCO-9/ })).toBeTruthy();
    act(() => setSession("shop-app-session"));
    expect(within(roster).queryByRole("button", { name: /INCO-9/ })).toBeNull();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(window.location.pathname).toBe("/agent/inco-2");
    expect(getSelectedAgent()).toBe("inco-2");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(window.location.pathname).not.toBe("/agent/inco-9");
  });

  describe("Assign", () => {
    const ready = (n: number, over = {}) =>
      boardItem({
        issueNumber: n,
        title: `Ticket ${n}`,
        status: "Ready",
        state: "planned",
        ...over,
      });
    const withDef = (def: Record<string, unknown>) => ({
      "/api/config": {
        ...CREW_CONFIG,
        crew: {
          ...CREW_CONFIG.crew,
          sessions: [
            {
              ...(CREW_CONFIG.crew?.sessions[0] as object),
              seats: [{ ...(CREW_CONFIG.crew?.sessions[0]?.seats[0] as object), ...def }],
            },
          ],
        },
      },
    });

    it.each([{ mode: "scratch" }, { loop: "watch" }])(
      "is not offered to a seat that cannot take a ticket (%j)",
      async (def) => {
        stub(seat({ hudState: "idle", run: null }), {
          ...withDef(def),
          "/api/boards/shop-app": [ready(7)],
        });
        render(<Agent id="guido-1" />);
        await screen.findByText("Work on shop-app#3349");
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByRole("button", { name: /^Assign/ })).toBeNull();
      },
    );

    it("takes the highest-priority, then oldest, Ready ticket", async () => {
      const f = stub(seat({ hudState: "idle", run: null }), {
        "/api/boards/shop-app": [
          ready(9, { priority: "P2" }),
          ready(8, { priority: "P0" }),
          ready(5, { priority: "P0" }),
          ready(2, { priority: "P1" }),
        ],
        "POST /api/seats/guido-1/start": { runId: "r-13" },
      });
      render(<Agent id="guido-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Assign #5" }));
      await screen.findByText("Assign confirmed.");
      const call = f.mock.calls.find(([path]) => path === "/api/seats/guido-1/start");
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ issue: 5 });
    });

    it("orders equal-priority tickets by creation time, not issue number", async () => {
      const f = stub(seat({ hudState: "idle", run: null }), {
        "/api/boards/shop-app": [
          ready(12, { priority: "P0", createdAt: NOW - 1 * MIN }),
          ready(90, { priority: "P0", createdAt: NOW - 60 * MIN }),
        ],
        "POST /api/seats/guido-1/start": { runId: "r-13" },
      });
      render(<Agent id="guido-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Assign #90" }));
      await screen.findByText("Assign confirmed.");
      const call = f.mock.calls.find(([path]) => path === "/api/seats/guido-1/start");
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ issue: 90 });
    });

    it("lets the operator pick another Ready ticket", async () => {
      const f = stub(seat({ hudState: "idle", run: null }), {
        "/api/boards/shop-app": [ready(5, { priority: "P0" }), ready(9, { priority: "P2" })],
        "POST /api/seats/guido-1/start": { runId: "r-13" },
      });
      render(<Agent id="guido-1" />);
      fireEvent.change(await screen.findByRole("combobox", { name: "Ticket to assign" }), {
        target: { value: "9" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Assign #9" }));
      await screen.findByText("Assign confirmed.");
      const call = f.mock.calls.find(([path]) => path === "/api/seats/guido-1/start");
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ issue: 9 });
    });
  });

  it("the live call bar shows the running tool and its elapsed time", async () => {
    const row = seat({
      digest: {
        ...(seat().digest as object),
        liveTool: { name: "Bash", since: NOW - 125_000 },
      },
    } as Partial<CrewRow>);
    stub(row);
    const { container } = render(<Agent id="guido-1" />);
    await screen.findByText("Work on shop-app#3349");
    const bar = container.querySelector(".livecall") as HTMLElement;
    expect(bar.textContent).toBe("▶Bash2:05elapsed");
  });

  it("the composer is disabled with the observed-loop hint", async () => {
    const loop = seat({ id: "guido-1", kind: "loop", loopKind: "ta-loop", sessionId: null });
    stub(loop);
    render(<Agent id="guido-1" />);
    await screen.findByText("Work on shop-app#3349");
    const input = screen.getByRole("textbox", { name: "Message this agent" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/is an observed loop/)).toBeTruthy();
  });

  it("Send posts {text}; Interrupt and send posts {text, interrupt: true}", async () => {
    const f = stub();
    render(<Agent id="guido-1" />);
    const input = await screen.findByRole("textbox", { name: "Message this agent" });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(f.mock.calls.filter((c) => c[0] === "/api/seats/guido-1/message").length).toBe(1),
    );
    const first = f.mock.calls.find((c) => c[0] === "/api/seats/guido-1/message");
    expect(JSON.parse(first?.[1]?.body as string)).toEqual({ text: "hello" });
    fireEvent.change(input, { target: { value: "  stop it" } });
    fireEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
    await waitFor(() =>
      expect(f.mock.calls.filter((c) => c[0] === "/api/seats/guido-1/message").length).toBe(2),
    );
    const last = f.mock.calls.filter((c) => c[0] === "/api/seats/guido-1/message")[1];
    expect(JSON.parse(last?.[1]?.body as string)).toEqual({ text: "  stop it", interrupt: true });
  });

  it("a whitespace-only input toasts and posts nothing", async () => {
    const f = stub();
    render(
      <>
        <Agent id="guido-1" />
        <Toast />
      </>,
    );
    fireEvent.change(await screen.findByRole("textbox", { name: "Message this agent" }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Type a message first.")).toBeTruthy();
    expect(f.mock.calls.some((c) => c[0] === "/api/seats/guido-1/message")).toBe(false);
  });

  it("Rename rejects blank and overlong names in place", async () => {
    const f = stub(seat(), {
      "/api/crew/changes": { sessions: [{ id: "s1", seats: [{ id: "guido-1" }] }] },
    });
    render(<Agent id="guido-1" />);
    fireEvent.click(await screen.findByText("More"));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Call sign" });
    for (const value of ["   ", "x".repeat(65)]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      expect((await screen.findByRole("alert")).textContent).toContain("1–64");
    }
    expect(f.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
