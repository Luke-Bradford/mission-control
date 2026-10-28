import { type ActivityEvent, type ConfigView, DEFAULT_AWAY } from "@mc/core";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { WorkInFlight } from "../src/flight/WorkInFlight.tsx";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { NeedsBanner } from "../src/overview/NeedsBanner.tsx";
import { Agent } from "../src/pages/Agent.tsx";
import { BoardPage } from "../src/pages/BoardPage.tsx";
import { Comms } from "../src/pages/Comms.tsx";
import { Overview } from "../src/pages/Overview.tsx";
import { Loops } from "../src/setup/Loops.tsx";
import { Sessions } from "../src/setup/Sessions.tsx";
import { Dock } from "../src/shell/Dock.tsx";
import { Header } from "../src/shell/Header.tsx";
import { nextAgent } from "../src/shell/selection.ts";
import { setSession, useSessionScope } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, brief, CREW_CONFIG, crewRow, item, NOW, REPOS, seatRow } from "./fixtures.ts";

const config: ConfigView = {
  ...CREW_CONFIG,
  crew: {
    ...(CREW_CONFIG.crew as NonNullable<ConfigView["crew"]>),
    sessions: ["alpha", "beta"].map((id) => ({
      id,
      repoId: "shop-app",
      checkout: "/mc/clone",
      seats: [],
    })),
  },
};
const rows = [
  seatRow({ id: "guido-1", sessionId: "alpha", ticket: "shop-app#1" }),
  seatRow({ id: "inco-1", sessionId: "beta", ticket: "shop-app#2", index: 1 }),
  seatRow({ id: "retro-1", sessionId: "beta", ticket: "shop-app#4", index: 2 }),
];

function stub(extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/config": config,
    "/api/repos": REPOS,
    "/api/crew": { rows, firstRunToday: null },
    "/api/crew/status": { enabled: true, note: null },
    "/api/attention": [],
    "/api/settings/away": DEFAULT_AWAY,
    "/api/machine": { latest: null },
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/flight": { seat: null, decisions: [] },
    "/api/boards/shop-app": [1, 2, 3, 4].map((n) =>
      boardItem({
        issueNumber: n,
        title: `Ticket ${n}`,
        ...(n === 4 ? { state: "done", status: "Done", closed: true } : {}),
      }),
    ),
    "/api/boards/site-builder": [],
    "/api/repos/shop-app/prs?linked=1": [],
    "/api/repos/site-builder/prs?linked=1": [],
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HUD chrome", () => {
  it.each([
    ["Overview Agents", () => <Overview />, "#agentsP"],
    ["Agent picker", () => <Agent id={null} />, "#picker"],
    ["Comms threads", () => <Comms item={null} />, "#chanList"],
  ])("filters %s by the crew session rather than its shared repo", async (_, page, selector) => {
    const loop = crewRow({ id: "shop-loop", sessionId: null, repoId: "shop-app" });
    stub({
      "/api/crew": {
        rows: [
          ...rows,
          loop,
          seatRow({ id: "other-repo", sessionId: "gamma", repoId: "site-builder" }),
        ],
      },
    });
    const { container } = render(page());
    await waitFor(() => expect(container.querySelector(selector)?.textContent).toContain("inco-1"));
    act(() => setSession("alpha"));
    expect(container.querySelector(selector)?.textContent).toContain("guido-1");
    expect(container.querySelector(selector)?.textContent).not.toContain("inco-1");
    expect(container.querySelector(selector)?.textContent).toContain("shop-loop");
    act(() => setSession("beta"));
    expect(container.querySelector(selector)?.textContent).not.toContain("guido-1");
    expect(container.querySelector(selector)?.textContent).toContain("inco-1");
    expect(container.querySelector(selector)?.textContent).toContain("shop-loop");
    act(() => setSession("gamma"));
    expect(container.querySelector(selector)?.textContent).toContain("other-repo");
    expect(container.querySelector(selector)?.textContent).not.toContain("shop-loop");
    for (const removed of ["removed", "shop-app"]) {
      act(() => setSession(removed));
      for (const id of ["guido-1", "inco-1", "retro-1", "shop-loop", "other-repo"])
        expect(container.querySelector(selector)?.textContent).not.toContain(id);
    }
  });

  it("filters Work in flight crew runs by session", async () => {
    stub();
    render(<WorkInFlight />);
    const runs = await screen.findByRole("table", { name: "Crew runs" });
    await within(runs).findByText("inco-1");
    act(() => setSession("alpha"));
    expect(within(runs).getByText("guido-1")).toBeTruthy();
    expect(within(runs).queryByText("inco-1")).toBeNull();
    act(() => setSession("beta"));
    expect(within(runs).queryByText("guido-1")).toBeNull();
    expect(within(runs).getByText("inco-1")).toBeTruthy();
  });

  it("falls back to all sessions in the header once config shows the chosen one was removed", async () => {
    stub();
    act(() => setSession("removed"));
    render(<Header page="overview" />);
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Session" }) as HTMLSelectElement).value).toBe(
        "all",
      ),
    );
  });

  it("keeps a removed session empty for both agents and repo data after config loads", async () => {
    stub();
    act(() => setSession("alpha"));
    const { result } = renderHook(() => useSessionScope());
    await waitFor(() => expect(result.current.repo).toBe("shop-app"));
    for (const removed of ["removed", "shop-app"]) {
      act(() => setSession(removed));
      expect(result.current.inView(seatRow({ sessionId: "alpha" }))).toBe(false);
      expect(result.current.inView(crewRow())).toBe(false);
      expect(result.current.inRepo("shop-app")).toBe(false);
      expect(result.current.inRepo("site-builder")).toBe(false);
    }
    act(() => setSession("all"));
    expect(result.current.inView(seatRow({ sessionId: "alpha" }))).toBe(true);
    expect(result.current.inView(crewRow())).toBe(true);
    expect(result.current.inRepo("shop-app")).toBe(true);
    expect(result.current.inRepo("site-builder")).toBe(true);
  });

  it("filters Activity by its agent's session and keeps collector events from that repo", async () => {
    stub({
      "/api/activity": [
        { at: NOW, who: "guido-1", kind: "state", text: "Alpha working" },
        { at: NOW, who: "inco-1", kind: "state", text: "Beta working" },
        { at: NOW, who: "github:shop-app", kind: "state", text: "Repo updated" },
      ].map(
        (e): ActivityEvent => ({
          ...e,
          kind: "state",
          ref: null,
          url: null,
          status: null,
          prs: [],
          summary: null,
        }),
      ),
    });
    render(<ActivityPanel />);
    await screen.findByText("Beta working");
    act(() => setSession("alpha"));
    expect(screen.getByText("Alpha working")).toBeTruthy();
    expect(screen.queryByText("Beta working")).toBeNull();
    expect(screen.getByText("Repo updated")).toBeTruthy();
  });

  it("filters Setup session panels by id and observed loops by the session's repo", async () => {
    stub();
    act(() => setSession("beta"));
    render(
      <>
        <Sessions config={config} />
        <Loops config={config} />
      </>,
    );
    expect(await screen.findByRole("region", { name: "s/beta" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "s/alpha" })).toBeNull();
    expect(screen.getByText("com.shop-app.ta-loop")).toBeTruthy();
  });

  it("lists distinct sessions on one repo and filters Overview, Board and keyboard selection", async () => {
    stub();
    const { container } = render(
      <>
        <Header page="overview" />
        <Overview />
        <BoardPage repoId={null} ticket={null} />
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Session" });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["All sessions", "s/alpha", "s/beta"]),
    );
    await screen.findByText("Ticket 1");
    for (const [session, agent, visible, hidden] of [
      ["alpha", "guido-1", 1, 2],
      ["beta", "inco-1", 2, 1],
    ] as const) {
      fireEvent.change(select, { target: { value: session } });
      const agents = container.querySelector("#agentsP") as HTMLElement;
      expect(within(agents).getByRole("link", { name: agent })).toBeTruthy();
      expect(
        within(agents).queryByRole("link", { name: session === "alpha" ? "inco-1" : "guido-1" }),
      ).toBeNull();
      expect(screen.getByText(`Ticket ${visible}`)).toBeTruthy();
      expect(screen.queryByText(`Ticket ${hidden}`)).toBeNull();
      expect(screen.getByText("Ticket 3")).toBeTruthy(); // unassigned
      expect(screen.getByText("Ticket 4")).toBeTruthy(); // Done, even with an out-of-view agent
      expect(nextAgent(rows, [], session, null, 1)).toBe(agent);
    }
  });

  it("includes sessions from crew rows without duplicating configured sessions", async () => {
    stub({ "/api/crew": { rows: [...rows, seatRow({ id: "fao-1", sessionId: "gamma" })] } });
    render(<Header page="overview" />);
    await waitFor(() =>
      expect(
        within(screen.getByRole("combobox", { name: "Session" }))
          .getAllByRole("option")
          .map((o) => o.getAttribute("value")),
      ).toEqual(["all", "alpha", "beta", "gamma"]),
    );
  });

  it("keeps unassigned and Done cards across repos under a session filter, within the chosen lane", async () => {
    stub({
      "/api/crew": {
        rows: [
          ...rows,
          seatRow({
            id: "guido-2",
            sessionId: "gamma",
            repoId: "site-builder",
            ticket: "site-builder#5",
          }),
          seatRow({
            id: "retro-2",
            sessionId: "gamma",
            repoId: "site-builder",
            ticket: "site-builder#7",
          }),
        ],
      },
      "/api/boards/site-builder": [
        boardItem({ repoId: "site-builder", issueNumber: 5, title: "Other active" }),
        boardItem({ repoId: "site-builder", issueNumber: 6, title: "Other unassigned" }),
        boardItem({
          repoId: "site-builder",
          issueNumber: 7,
          title: "Other done",
          status: "Done",
          state: "done",
          closed: true,
        }),
      ],
    });
    render(<BoardPage repoId={null} ticket={null} />);
    await screen.findByText("Other active");
    act(() => setSession("alpha"));
    expect(screen.queryByText("Other active")).toBeNull();
    expect(screen.getByText("Other unassigned")).toBeTruthy();
    expect(screen.getByText("Other done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "shop-app" }));
    expect(screen.queryByText("Other unassigned")).toBeNull();
    expect(screen.queryByText("Other done")).toBeNull();
    expect(screen.getByText("Ticket 1")).toBeTruthy();
  });

  it("never lights the Board tab: Needs you is the one lamp", async () => {
    stub({ "/api/attention": [item({ kind: "pr", escalationId: null })] });
    render(<Header page="board" />);
    await screen.findByRole("button", { name: /^Needs you 1:/ });
    const board = within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", {
      name: /^Board/,
    });
    expect(within(board).queryByRole("img")).toBeNull();
  });

  it("stops banner, agent and card pulses after acknowledgement while keeping the counts and needs state", async () => {
    let attention = [item({ agentId: "guido-1", ticket: "shop-app#1" })];
    stub({ "/api/attention": () => ({ status: 200, body: attention }) });
    const { container } = render(
      <>
        <NeedsBanner />
        <Overview />
        <BoardPage repoId={null} ticket={null} />
      </>,
    );
    const selectors = [
      "#nbanner",
      '.trow:has(a[href="/agent/guido-1"])',
      '[data-card="shop-app#1"]',
    ];
    await waitFor(() => {
      for (const selector of selectors)
        expect(container.querySelector(`${selector} .lamp.pulse`)).not.toBeNull();
    });
    attention = attention.map((i) => ({ ...i, acked: true }));
    act(() => hub.refetch(RESOURCES.attention.path));
    await waitFor(() => {
      for (const selector of selectors) {
        expect(container.querySelector(`${selector} .lamp.pulse`)).toBeNull();
        expect(container.querySelector(`${selector} .lamp.warn`)).not.toBeNull();
      }
    });
    expect(
      container.querySelector('[data-card="shop-app#1"]')?.classList.contains("pulse-warn"),
    ).toBe(false);
    expect(container.querySelector("#nbanner .num")?.textContent).toBe("1");
    expect(
      container.querySelector('.trow:has(a[href="/agent/guido-1"])')?.classList.contains("needs"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Needs me" }));
    expect(screen.getByText("Ticket 1")).toBeTruthy();
    expect(screen.queryByText("Ticket 3")).toBeNull();
  });

  it("shows FLIGHT's doing line and the target tag on every waiting ask as inert text", async () => {
    stub({
      "/api/flight": {
        seat: {
          id: "flight-1",
          call: "FLIGHT-1",
          model: "opus",
          state: "running",
          live: true,
          turns: null,
        },
        decisions: [],
      },
      "/api/crew": {
        rows: [
          ...rows,
          seatRow({ id: "flight-1", hudState: "blocked", note: "Checking <b>the lock</b>" }),
        ],
      },
      "/api/attention": [
        item({ key: "ask:1", agentId: "guido-1", brief: brief() }),
        item({ key: "ask:2", agentId: "inco-1", brief: brief(), text: "Use <img src=x> here?" }),
      ],
    });
    const { container } = render(<Dock />);
    await waitFor(() =>
      expect(container.querySelector("#dockHead .meta")?.textContent).toContain(
        "Checking <b>the lock</b>",
      ),
    );
    const asks = await screen.findAllByTestId("waiting-ask");
    expect(asks.map((a) => a.querySelector(".ag")?.textContent)).toEqual(["guido-1", "inco-1"]);
    expect(asks[1]?.textContent).toContain("Use <img src=x> here?");
    expect(container.querySelector("#dockHead .meta b, .dask img")).toBeNull();
  });
});
