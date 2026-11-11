import type { AgentStream, CrewRow } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/pages/Agent.tsx";
import { AGENT_DRAFT_KEY, readKey } from "../src/storage.ts";
import { agentView } from "./agentV2Fixture.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, crewRow, MIN, NOW, stoppedSeat } from "./fixtures.ts";

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
    "/api/config": CONFIG,
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
    await waitFor(() => expect(readKey(AGENT_DRAFT_KEY)).toBe("Please check the guard."));
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
});
