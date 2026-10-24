import {
  type ActivityEvent,
  type ActivityRow,
  type AttentionItem,
  type CommsEvent,
  type CrewLoop,
  type CrewRow,
  DEFAULT_PROFILES,
  GITHUB_SLOWED_PREFIX,
  type GithubRateState,
  type HealthRow,
  type LimitRow,
  LOCK_FREE_TEXT,
  LOCK_NOBODY_WAITING,
  type MachineSample,
  type PullRequestView,
  SEAT_TURN_END_TEXT,
  SEAT_TURN_START_TEXT,
  type TestLockState,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { FLIGHT_NO_SEAT } from "../src/flight/flightTypes.ts";
import { NeedsBanner } from "../src/overview/NeedsBanner.tsx";
import { Overview } from "../src/pages/Overview.tsx";
import { useItem } from "../src/shell/overlays.ts";
import { setSession } from "../src/shell/session.ts";
import { settled, stubFetch } from "./fetchStub.ts";
import {
  CONFIG,
  CREW_CONFIG,
  crewRow,
  GITHUB_RATE,
  GITHUB_RATE_LINE,
  HOUR,
  item,
  itemWithoutOwner,
  limit5h,
  limit7d,
  MIN,
  NOW,
  prView,
  SESSION_CONFIG,
  seatRow,
  stoppedSeat,
} from "./fixtures.ts";

const GIB = 2 ** 30;

function sample(over: Partial<MachineSample> = {}): MachineSample {
  return {
    at: NOW,
    cpuPct: 37.4,
    cores: 16,
    memUsedBytes: 20.5 * GIB,
    memTotalBytes: 64 * GIB,
    diskFreeBytes: 412 * GIB,
    diskTotalBytes: 1000 * GIB,
    agents: { count: 3, rssBytes: 2 * GIB, cpuPct: 80 },
    ...over,
  };
}

interface Data {
  rows?: CrewRow[];
  items?: AttentionItem[];
  machine?: MachineSample | null;
  limits?: LimitRow[];
  githubRate?: GithubRateState;
  health?: HealthRow[];
  activity?: ActivityRow[];
  away?: unknown;
  lock?: TestLockState;
  config?: unknown;
  crewStatus?: { enabled: boolean; note: string | null };
  /** The seats' repo's PRs. */
  prs?: PullRequestView[];
  /** The crew's seat capacity, as `/api/machine` sends it. */
  seats?: { maxSeats: number; seats: number; perSessionMax: number };
  /** The activity feed, read at each fetch. */
  activityNow?: () => ActivityRow[];
  /** More routes, by "METHOD path". */
  extra?: Record<string, unknown>;
}

function stub(d: Data = {}) {
  return stubFetch({
    ...d.extra,
    "/api/crew": { rows: d.rows ?? [], firstRunToday: null },
    "/api/attention": d.items ?? [],
    "/api/machine": { latest: d.machine === undefined ? sample() : d.machine, ...d.seats },
    "/api/limits": d.limits ?? [],
    "/api/limits/github": d.githubRate ?? { queries: {}, pollCost: null },
    "/api/health": d.health ?? [],
    "/api/activity": d.activityNow
      ? () => ({ status: 200, body: d.activityNow?.() })
      : (d.activity ?? []),
    "/api/settings/away": d.away ?? { on: false, until: "", may: {} },
    "/api/config": d.config ?? CONFIG,
    "/api/test-lock": d.lock ?? { holder: null, waiting: [] },
    "/api/crew/status": d.crewStatus ?? { enabled: true, note: null },
    "/api/repos/shop-app/prs?linked=1": d.prs ?? [],
  });
}

function Probe() {
  return <span data-testid="item">{useItem() ?? "none"}</span>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const agentRows = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>(".trow:not(.head):not(.flight)"),
];

describe("Overview panels", () => {
  it("every panel carries its mockup id", async () => {
    stub();
    const { container } = render(<Overview />);
    for (const id of ["agentsP", "actP", "machP", "quotaP"]) {
      expect(container.querySelector(`#${id}`), id).toBeTruthy();
    }
    await screen.findByText("Nothing is waiting on you.");
  });
});

describe("Agents panel", () => {
  it("a row whose account has only a 7d window shows that first reading", async () => {
    stub({
      rows: [crewRow({ accountId: "codex-main" })],
      limits: [limit7d({ accountId: "codex-main", used: 69 })],
    });
    const { container } = render(<Overview />);
    await waitFor(() => expect(agentRows(container).length).toBe(1));
    const text = agentRows(container)[0]?.textContent ?? "";
    expect(text).toContain("69%");
    expect(text).not.toContain("5h");
  });

  it("its header opens Setup Sessions to add an agent to the first crew session", async () => {
    const crew = CREW_CONFIG.crew;
    const first = crew?.sessions[0];
    if (!crew || !first) throw new Error("no crew session");
    const f = stub({
      config: {
        ...CREW_CONFIG,
        crew: { ...crew, sessions: [first, { ...first, id: "s2" }] },
      },
    });
    const { container } = render(<Overview />);
    await settled(f, "/api/config");
    const header = container.querySelector<HTMLElement>("#agentsP .ph") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "Add agent" }));
    expect(window.location.pathname + window.location.search).toBe("/setup/sessions?add=s1");
  });

  it("disables Add agent when there is no crew session", async () => {
    expect(CONFIG.crew?.sessions ?? []).toEqual([]);
    const f = stub({ config: CONFIG });
    render(<Overview />);
    await settled(f, "/api/config");
    expect((screen.getByRole("button", { name: "Add agent" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says Crew is off with the note when the server has crew off", async () => {
    stub({ crewStatus: { enabled: false, note: "crew lock held by pid 123" } });
    const { container } = render(<Overview />);
    const line = await screen.findByRole("status");
    expect(line.textContent).toBe("Crew off");
    expect(line.title).toBe("crew lock held by pid 123");
    expect(container.querySelector("#agentsP .ph")?.contains(line)).toBe(true);
  });

  it("says plain Crew is off with no note", async () => {
    stub({ crewStatus: { enabled: false, note: null } });
    render(<Overview />);
    expect(await screen.findByText("Crew off")).toBeTruthy();
  });

  it("says nothing about crew when it is on", async () => {
    const f = stub({ rows: [crewRow()] });
    const { container } = render(<Overview />);
    await screen.findByText("shop-app-ta");
    await settled(f, "/api/crew/status");
    expect(container.textContent).not.toContain("Crew is off");
  });

  it("shows the FLIGHT row first, with its not-running line and dashes", async () => {
    stub({ rows: [crewRow()] });
    const { container } = render(<Overview />);
    await screen.findByText("shop-app-ta");
    const flight = container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    expect(container.querySelector(".trow:not(.head)")).toBe(flight);
    expect(within(flight).getByText("FLIGHT")).toBeTruthy();
    expect(within(flight).getByText("head agent")).toBeTruthy();
    expect(flight.title).toBe(FLIGHT_NO_SEAT);
    expect(flight.textContent).toContain("—");
  });

  const flightConfig = (seats: { id: string; retiring?: boolean }[]) => ({
    ...CONFIG,
    crew: {
      worktrees: "/mc/crew",
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: "/mc/clone",
          seats: seats.map((s) => ({
            role: "FLIGHT",
            mode: "read-only",
            loop: "watch",
            accountId: "claude-main",
            model: "opus",
            area: [],
            ...s,
          })),
        },
      ],
    },
  });

  it("keeps FLIGHT's session turns in the loop tooltip", async () => {
    stub({
      config: flightConfig([{ id: "flight-1" }]),
      rows: [crewRow({ id: "flight-1", hudState: "error" })],
      extra: {
        "/api/flight": {
          seat: {
            id: "flight-1",
            call: "FLIGHT-1",
            model: "opus",
            live: true,
            state: "idle",
            turns: { n: 4, max: 41 },
          },
          decisions: [],
        },
      },
    });
    const { container } = render(<Overview />);
    const flight = container.querySelector(".trow.flight") as HTMLElement;
    await waitFor(() =>
      expect(flight.querySelector(".loopstep")?.getAttribute("title")).toBe(
        "Turns this session: 4",
      ),
    );
    expect(flight.querySelector(".loopstep")?.getAttribute("title")).toBe("Turns this session: 4");
    expect(within(flight).getByText("Error", { selector: ".pill > span" })).toBeTruthy();
  });

  it("the FLIGHT row is the seat the server treats as FLIGHT: a retiring one lists as an agent", async () => {
    const seat = (over: Partial<CrewRow>) =>
      crewRow({ kind: "crew", role: "FLIGHT", mode: "read-only", loopKind: "crew", ...over });
    stub({
      rows: [
        seat({ id: "flight-1", index: 3, hudState: "idle" }),
        seat({ id: "flight-2", index: 4, hudState: "error", ticket: null }),
      ],
      config: flightConfig([{ id: "flight-1", retiring: true }, { id: "flight-2" }]),
    });
    const { container } = render(<Overview />);
    await screen.findByText("flight-1");
    const flight = container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    expect(within(flight).getByText("Error")).toBeTruthy();
    expect(agentRows(container)).toHaveLength(1);
    expect(within(agentRows(container)[0] as HTMLElement).getByText("flight-1")).toBeTruthy();
  });

  it("the FLIGHT row shows the live seat, once, and the subtitle leaves it out", async () => {
    const seat = (over: Partial<CrewRow>) =>
      crewRow({ kind: "crew", role: "Developer", mode: "writer", loopKind: "crew", ...over });
    stub({
      config: flightConfig([{ id: "flight-1" }]),
      rows: [
        seat({ id: "flight-1", index: 3, hudState: "error", ticket: null }),
        seat({ id: "dev-1", index: 0 }),
        seat({ id: "dev-2", index: 1, hudState: "idle" }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("1 working · 2 agents · FLIGHT not counted");
    const flight = container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    expect(within(flight).queryByText(FLIGHT_NO_SEAT)).toBeNull();
    expect(within(flight).getByText("head agent")).toBeTruthy();
    expect(within(flight).getByText("Error")).toBeTruthy();
    expect(flight.title).toBe("Run failed");
    expect(flight.querySelector(".meter")?.textContent).toContain("ctx");
    expect(agentRows(container)).toHaveLength(2);
    expect(screen.queryByText("flight-1")).toBeNull();
    expect(screen.getAllByText("FLIGHT")).toHaveLength(1);
  });

  it("while the config loads the FLIGHT row says Loading…; a config error keeps not running", async () => {
    const fn = stub({ rows: [crewRow()] });
    const answer = fn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fn.mockImplementation(async (...a: unknown[]) => {
      if (a[0] === "/api/config") await gate;
      return answer(...a);
    });
    const { container, unmount } = render(<Overview />);
    await screen.findByText("shop-app-ta");
    const flight = container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    expect(flight.title).toBe("Loading…");
    expect(within(flight).queryByText(FLIGHT_NO_SEAT)).toBeNull();
    release();
    await waitFor(() => expect(flight.title).toBe(FLIGHT_NO_SEAT));
    unmount();
    hub.clear();

    stub({ rows: [crewRow()], config: () => ({ status: 503, body: { error: "loading" } }) });
    const failed = render(<Overview />);
    await screen.findByText("shop-app-ta");
    const row = failed.container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    await waitFor(() => expect(row.title).toBe(FLIGHT_NO_SEAT));
    expect(within(row).queryByText("Loading…")).toBeNull();
  });

  it("the FLIGHT row is not itself a button: its call sign is the button that opens the dock", async () => {
    stub({ rows: [crewRow()] });
    const { container } = render(<Overview />);
    await screen.findByText("shop-app-ta");
    const flight = container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    expect(flight.getAttribute("role")).toBe("row");
    expect(flight.hasAttribute("tabindex")).toBe(false);
    const btn = within(flight).getByRole("button", { name: "FLIGHT, open the dock" });
    // the accessible name starts with the call sign, the visible text's first words (WCAG 2.5.3)
    expect(btn.textContent?.startsWith("FLIGHT")).toBe(true);
  });

  it("subtitle counts the working agents and says FLIGHT is not counted", async () => {
    stub({
      rows: [
        crewRow({ id: "a" }),
        crewRow({ id: "b", index: 1, hudState: "idle" }),
        crewRow({ id: "c", index: 2, hudState: "running" }),
      ],
    });
    render(<Overview />);
    await screen.findByText("2 working · 3 agents · FLIGHT not counted");
  });

  const loopOf = (phase: CrewLoop["phase"], text: string, prNumber: number | null = null) => ({
    phase,
    text,
    prNumber,
    parked: phase === "parked" ? text : null,
  });
  /** The Loop step label, whose `<b>` splits its text, found by its whole text content. */
  const stepLabel = (text: string) =>
    screen.findByText(
      (_, el) =>
        el?.matches(".loopstep .ellip") === true &&
        el.textContent === text.split(" › ").at(-1)?.split(" · try")[0],
    );
  const bar = (row: HTMLElement | undefined) =>
    [...(row?.querySelectorAll(".loopstep .stepbar i") ?? [])].map((i) => i.className);

  it("the step bar follows the run's profile steps", async () => {
    const loop: CrewLoop = {
      ...loopOf("ci", "CI is running"),
      profile: "feature",
      step: "verify",
      steps: DEFAULT_PROFILES.find((p) => p.name === "feature")?.steps,
      planned: true,
    };
    stub({ rows: [crewRow({ loop })] });
    const { container } = render(<Overview />);
    await stepLabel("feature › verify");
    const row = agentRows(container)[0];
    expect(bar(row)).toEqual(["d", "", "c", "", ""]);
    expect(row?.querySelector(".stepbar")?.getAttribute("title")).toBe(
      "implement → draft PR → verify → review → merge",
    );
  });

  it("the Loop step column shows the loop type, step and a step bar; a dash without a loop", async () => {
    const loop = loopOf("review", "In review · PR #9", 9);
    stub({ rows: [crewRow({ loop }), crewRow({ id: "other", index: 1, loop: null })] });
    const { container } = render(<Overview />);
    await screen.findByText("other");
    const [a, b] = agentRows(container);
    const label = a?.querySelector(".loopstep .ellip") as HTMLElement;
    expect(label.textContent).toBe("In review");
    expect(label.querySelector("b")?.textContent).toBe("In review");
    expect(label.getAttribute("title")).toBe("build › In review · In review · PR #9");
    expect(a?.querySelector(".loopstep .stepbar")?.getAttribute("title")).toBe(
      "Working → CI → In review → Done",
    );
    expect(bar(a)).toEqual(["d", "d", "c", ""]);
    expect(b?.querySelector(".loopstep")?.textContent).toBe("—");
  });

  it("an idle seat waiting in CI shows the same cell as a running one", async () => {
    const loop = loopOf("ci", "CI on 08a7cfc");
    stub({ rows: [crewRow({ loop, hudState: "idle" })] });
    const { container } = render(<Overview />);
    await stepLabel("build › CI");
    expect(bar(agentRows(container)[0])).toEqual(["d", "c", "", ""]);
  });

  it("a parked loop holds the whole bar and reads Blocked, with the loop text in the title", async () => {
    const text = "Blocked: CI failed 3 times; last on 08a7cfc";
    stub({ rows: [crewRow({ loop: loopOf("parked", text), hudState: "parked" })] });
    const { container } = render(<Overview />);
    await stepLabel("build › Blocked");
    const step = agentRows(container)[0] as HTMLElement;
    expect(bar(step)).toEqual(["w", "w", "w", "w"]);
    expect(step.querySelector(".loopstep .ellip")?.getAttribute("title")).toBe(
      `build › Blocked · ${text}`,
    );
    expect(step.querySelector(".loopstep .crit-t")).toBeNull();
  });

  it("a finished loop has every segment done", async () => {
    stub({ rows: [crewRow({ loop: loopOf("done", "Done · PR #205", 205), hudState: "idle" })] });
    const { container } = render(<Overview />);
    await stepLabel("build › Done");
    expect(bar(agentRows(container)[0])).toEqual(["d", "d", "d", "d"]);
  });

  it("a stalled seat's current segment is amber", async () => {
    stub({
      rows: [
        crewRow({ loop: loopOf("working", "Working on mission-control#198"), hudState: "stalled" }),
      ],
    });
    const { container } = render(<Overview />);
    await stepLabel("build › Working");
    expect(bar(agentRows(container)[0])).toEqual(["w", "", "", ""]);
  });

  // The ticket ref the set-aside run carries: the repo, a hash sign, the number.
  const ASIDE_TICKET = "mission-control#12";

  it("a seat's set-aside run stays in its identity tooltip, with one compact row", async () => {
    stub({
      rows: [
        seatRow({
          hudState: "running",
          loop: { ...loopOf("working", "Working on the ticket"), wait: null },
          asideRuns: [
            {
              runId: "r-9",
              ticket: ASIDE_TICKET,
              ticketTitle: "Aside work",
              loop: { ...loopOf("review", "In review", 9), wait: "retro" },
            },
          ],
        }),
      ],
    });
    const { container } = render(<Overview />);
    await stepLabel("build › Working");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(":scope > .loopstep .loopwait")).toBeNull();
    expect(row.querySelector(".asideline")).toBeNull();
    const model = row.querySelector(".agent-model") as HTMLElement;
    expect(model.textContent).not.toContain("set aside");
    for (const text of [
      "Set aside",
      "#12",
      "Aside work",
      "In review",
      "waiting on RETRO's review",
    ]) {
      expect(model.title).toContain(text);
    }
  });

  it("a free seat keeps its set-aside work available in the identity tooltip", async () => {
    stub({
      rows: [
        seatRow({
          run: null,
          loop: null,
          asideRuns: [
            {
              runId: "r-9",
              ticket: ASIDE_TICKET,
              ticketTitle: "Aside work",
              loop: { ...loopOf("review", "In review", 9), wait: "seat" },
            },
          ],
        }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".loopstep")?.textContent).toBe("—");
    expect(row.querySelector(".agent-model")?.getAttribute("title")).toContain(
      "waiting on GUIDO-1 for rework",
    );
  });

  it("the Loop step shows the try from the second one on", async () => {
    stub({
      rows: [
        crewRow({
          loop: { ...loopOf("ci", "CI on 08a7cfc"), tries: { n: 2, max: 3 } },
          hudState: "idle",
        }),
        crewRow({
          id: "other",
          index: 1,
          loop: { ...loopOf("ci", "CI on 1a2b3c4"), tries: { n: 1, max: 3 } },
          hudState: "idle",
        }),
      ],
    });
    render(<Overview />);
    expect(await screen.findAllByText("CI", { selector: ".loopstep b" })).toHaveLength(2);
    expect(screen.getByTitle(/try 2 of 3/)).toBeTruthy();
  });

  it("the Loop step names the run's template profile, else the build loop", async () => {
    stub({
      rows: [
        crewRow({
          loop: { ...loopOf("ci", "CI on 08a7cfc"), profile: "feature", step: "verify" },
        }),
      ],
    });
    render(<Overview />);
    await stepLabel("feature › verify");
  });

  it("a run in line for the test lock says how long, in amber", async () => {
    stub({
      rows: [seatRow({ loop: { ...loopOf("working", "Working on the ticket"), wait: "lock" } })],
      lock: {
        holder: null,
        waiting: [
          { runId: "r-12", seatId: "guido-1", command: "pnpm -s test", since: NOW - 65_000 },
        ],
      },
    });
    render(<Overview />);
    const el = await screen.findByTitle(/in line for the test lock · 1:05/);
    expect(el.closest(".trow")?.textContent).toContain("Waiting on lock");
  });

  it("the need line offers Interrupt and End the run next to Answer, for a seat with a live turn", async () => {
    stub({
      rows: [seatRow({ hudState: "running" }), crewRow({ id: "other", index: 1 })],
      items: [
        item({ key: "k-seat", agentId: "guido-1", kind: "decision" }),
        item({ key: "k-loop", agentId: "other", kind: "decision" }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findAllByRole("button", { name: "Answer" });
    const [seat, loop] = agentRows(container) as [HTMLElement, HTMLElement];
    expect(within(seat).getByRole("button", { name: "Interrupt" })).toBeTruthy();
    expect(within(seat).getByRole("button", { name: "End the run" })).toBeTruthy();
    expect(within(loop).queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(within(loop).queryByRole("button", { name: "End the run" })).toBeNull();
  });

  describe("the need line of a stalled seat", () => {
    const stall = item({
      key: "stall:guido-1:r-12",
      agentId: "guido-1",
      kind: "stalled",
      at: NOW - 11 * MIN,
      tool: "Bash",
      ticket: null,
      escalationId: null,
    });
    const stalled = () => seatRow({ hudState: "stalled", lastOutputAt: NOW - 11 * MIN });
    const interrupts = () => ({
      "POST /api/seats/guido-1/interrupt": { ok: true },
    });
    const posted = (fn: ReturnType<typeof stub>) =>
      fn.mock.calls.filter(([u]) => u === "/api/seats/guido-1/interrupt");

    it("holding the test lock reads Stop the run, and the row has no second Interrupt", async () => {
      const fn = stub({
        rows: [stalled()],
        items: [stall],
        lock: {
          holder: {
            runId: "r-12",
            seatId: "guido-1",
            command: "pnpm -s test",
            since: NOW - 12 * MIN,
          },
          waiting: [
            { runId: "r-2", seatId: "guido-2", command: "pnpm -s test", since: NOW - MIN },
            { runId: "r-3", seatId: "guido-3", command: "pnpm -s test", since: NOW - MIN },
          ],
        },
        extra: interrupts(),
      });
      const { container } = render(<Overview />);
      const need = await waitFor(() => {
        const el = container.querySelector(".need") as HTMLElement;
        expect(el.textContent).toContain("Stalled 11:00 and holding the test lock; 2 waiting");
        return el;
      });
      expect(within(need).queryByRole("button", { name: "Interrupt" })).toBeNull();
      fireEvent.click(within(need).getByRole("button", { name: "Stop the run" }));
      await waitFor(() => expect(posted(fn)).toHaveLength(1));
      expect(JSON.parse(String(posted(fn)[0]?.[1]?.body))).toEqual({});
    });

    it("holding nothing reads the tool, with one Interrupt that stops the turn", async () => {
      const fn = stub({ rows: [stalled()], items: [stall], extra: interrupts() });
      const { container } = render(<Overview />);
      const need = await waitFor(() => {
        const el = container.querySelector(".need") as HTMLElement;
        expect(el.textContent).toContain("Stalled 11:00 in Bash");
        return el;
      });
      expect(within(need).queryByRole("button", { name: "Stop the run" })).toBeNull();
      const buttons = within(need).getAllByRole("button", { name: "Interrupt" });
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0] as HTMLElement);
      await waitFor(() => expect(posted(fn)).toHaveLength(1));
    });
  });

  it("the Loop step column keeps its alignment even when no row has a loop", async () => {
    const loop = { phase: "review" as const, text: "In review · PR #9", prNumber: 9, parked: null };
    stub({ rows: [crewRow({ loop: null }), crewRow({ id: "other", index: 1, loop: null })] });
    const none = render(<Overview />);
    const list = () => none.container.querySelector("#agentsList") as HTMLElement;
    // still loading: no collapse, so the columns do not jump when the rows arrive
    expect(list().className).not.toContain("noloop");
    await screen.findByText("other");
    expect(list().className).not.toContain("noloop");
    none.unmount();
    hub.clear();
    stub({ rows: [crewRow({ loop }), crewRow({ id: "other", index: 1, loop: null })] });
    const some = render(<Overview />);
    await screen.findByText("other");
    expect(some.container.querySelector("#agentsList")?.className).not.toContain("noloop");
  });

  it("a stopped studio loop shows its stop line, whole in the title", async () => {
    const stop = {
      reason: "7-day quota utilization 88% >= QUOTA_STOP_PCT=80% -- refusing to fire",
      at: NOW - HOUR,
      quota: { usedPct: 88, stopPct: 80 },
      resumesAt: NOW + 2 * 24 * HOUR,
    };
    stub({ rows: [crewRow({ hudState: "stopped", stop, run: null, ticket: null })] });
    const { container } = render(<Overview />);
    await screen.findByText("Stopped");
    const row = agentRows(container)[0] as HTMLElement;
    const line = "Stopped at the 7-day quota (88% of 80%) · resumes after Mon 13:00";
    expect(row.title).toBe(line);
    expect(row.title).toBe(line);
  });

  it("a stopped seat whose run merged says so, and keeps its ticket in Work", async () => {
    stub({ rows: [stoppedSeat({ merged: true })] });
    const { container } = render(<Overview />);
    await screen.findByText("Stopped");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.title).toBe("Run ended · PR #75 merged");
    expect(row.querySelector(".ticket-cell")?.textContent).toContain("#74");
    expect(row.title).not.toContain("Dead collector fallback");
    expect(row.querySelector(".ticket-cell")?.textContent).toMatch(/^last #74/);
  });

  it("a seat stopped by you says so", async () => {
    stub({ rows: [stoppedSeat()] });
    const { container } = render(<Overview />);
    await screen.findByText("Stopped");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.title).toBe("Run ended by you");
    expect(row.querySelector(".ticket-cell")?.textContent).toContain("#74");
  });

  it("a seat in error says its run failed and keeps its ticket in Work", async () => {
    stub({
      rows: [stoppedSeat({ hudState: "error", sourceError: "CLI never started" })],
    });
    const { container } = render(<Overview />);
    await screen.findByText("Error");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".need")?.textContent).toContain("CLI never started");
    expect(row.querySelector(".doing")).toBeNull();
    expect(row.querySelector(".ticket-cell")?.textContent).toContain("#74");
    expect(row.title).not.toContain("Dead collector fallback");
  });

  it("a loop in error keeps its last ticket without the title", async () => {
    stub({ rows: [crewRow({ hudState: "error", sourceError: "state dir gone" })] });
    const { container } = render(<Overview />);
    await screen.findByText("Error");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".need")?.textContent).toContain("state dir gone");
    expect(row.querySelector(".doing")).toBeNull();
    expect(row.textContent).not.toContain("Quote cache");
    expect(row.querySelector(".ticket-cell")?.textContent).toBe("last #3349");
    expect(row.textContent).not.toContain("Last ");
    expect(row.querySelector(".muted .rref")).toBeNull();
  });

  it("a seat in error with no reason says only Run failed", async () => {
    stub({ rows: [stoppedSeat({ hudState: "error", sourceError: null })] });
    const { container } = render(<Overview />);
    await screen.findByText("Error");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.title).toBe("Run failed");
  });

  it("a row keeps its call sign and full short role together", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    stub({ rows: [seatRow()] });
    const { container } = render(<Overview />);
    await screen.findByText("backend");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".ag")?.textContent).toBe("guido-1");
    expect(row.querySelector(".ag")?.getAttribute("title")).toBe("Backend developer");
    const flight = container.querySelector<HTMLElement>(".trow.flight") as HTMLElement;
    expect(flight.querySelector(".ag")?.textContent).toBe("FLIGHT");
  });

  it("an agent's row shows model, effort and CLI version with the full id on hover", async () => {
    stub({
      rows: [
        seatRow({ cli: { version: "2.1.302", effort: "high" } }),
        crewRow({ id: "studio", index: 1, cli: { version: null, effort: null } }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const [seat, loop] = agentRows(container);
    expect(seat?.querySelector<HTMLElement>(".agent-model")?.title).toBe(
      "claude-opus-4-1 · high · CLI 2.1.302",
    );
    expect(within(loop as HTMLElement).getByText("opus 4.1").title).toBe("claude-opus-4-1");
  });

  it.each([
    ["open", "In review · PR #77"],
    ["approved", "In review · PR #77"],
    ["draft", "Draft PR #77"],
    ["changes", "Changes requested · PR #77"],
  ] as const)(
    "an idle seat keeps %s PR in its tooltip and marks Work as last",
    async (state, line) => {
      stub({ rows: [seatRow({ hudState: "idle", review: { prNumber: 77, state } })] });
      const { container } = render(<Overview />);
      await screen.findByText("guido-1");
      const row = agentRows(container)[0] as HTMLElement;
      const doing = row.querySelector(".ticket-cell") as HTMLElement;
      expect(row.title).toBe(line);
      expect(doing.textContent).toBe("last #3349 · PR #77");
      expect(doing.hasAttribute("title")).toBe(false);
    },
  );

  it("a seat's note outranks its review, and a seat that is not idle does not show one", async () => {
    const review = { prNumber: 77, state: "open" } as const;
    stub({
      rows: [
        seatRow({ hudState: "idle", note: "Rate limited until 14:00", review }),
        seatRow({ id: "guido-2", index: 1, hudState: "running", review }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-2");
    const line = (id: string) =>
      agentRows(container)
        .find((r) => r.textContent?.includes(id))
        ?.getAttribute("title");
    expect(line("guido-1")).toBe("Rate limited until 14:00");
    expect(line("guido-2")).toMatch(/^run #12/);
  });

  it("a repo missing from the config leaves the PR as plain text, not a link", async () => {
    stub({
      rows: [
        seatRow({ hudState: "idle", repoId: "gone", review: { prNumber: 77, state: "open" } }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const row = agentRows(container)[0] as HTMLElement;
    const doing = row.querySelector(".ticket-cell") as HTMLElement;
    await waitFor(() => expect(row.title).toBe("In review · PR #77"));
    expect(within(doing).queryByRole("link", { name: "gone PR #77" })).toBeNull();
  });

  it("an idle seat with no PR stays Idle; a loop never reads as in review", async () => {
    stub({
      rows: [
        seatRow({ hudState: "idle", review: null }),
        crewRow({ id: "loop", index: 1, hudState: "idle", review: { prNumber: 5, state: "open" } }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const lines = agentRows(container).map((r) => r.getAttribute("title"));
    expect(lines[0]).toMatch(/^Idle since/);
    expect(lines[1]).toMatch(/^Idle since/);
  });

  it("the doing line shows its text before the timezone has loaded", async () => {
    stub({
      rows: [crewRow({ hudState: "idle", run: null, digest: null, ticket: null })],
      config: () => ({ status: 503, body: { error: "loading" } }),
    });
    const { container } = render(<Overview />);
    await screen.findByText("shop-app-ta");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.title).toBe("Idle");
  });

  it("a row with no run and no digest shows No ticket, — tokens and ctx —", async () => {
    stub({
      rows: [
        crewRow({
          hudState: "idle",
          run: null,
          digest: null,
          ticket: null,
          ticketTitle: null,
          contextWindow: null,
        }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("shop-app-ta");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".tok")?.textContent).toContain("0/min");
    expect(row.textContent).toContain("ctx —");
    expect(row.querySelectorAll(".meter")[1]?.textContent).toContain("—");
    expect(row.title).toContain("Idle since");
    expect(row.querySelector(".spark")).toBeTruthy();
  });

  it("a loop cell stays one line with live tool detail in the row tooltip", async () => {
    const detail = "x".repeat(60);
    const row = crewRow({
      loop: { phase: "working", text: "Implement cache", prNumber: null, parked: null },
    });
    stub({
      rows: [
        {
          ...row,
          digest: {
            lastText: "Implement cache",
            toolCalls: 1,
            turns: 1,
            lastEventAt: NOW,
            model: null,
            contextTokens: null,
            contextWindow: null,
            tools: {},
            subagents: [],
            minuteTokens: [],
            turnUsage: [],
            background: [],
            compactions: 0,
            liveTool: { name: "Bash", detail, since: NOW - 65_000 },
          },
        } as CrewRow,
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("Quote cache");
    const agent = agentRows(container)[0] as HTMLElement;
    const cell = agent.querySelector(".loopstep") as HTMLElement;
    expect(cell.textContent).toBe("Working");
    expect(cell.querySelector(".process-line")).toBeNull();
    expect(agent.title).toBe(`Bash 1:05 · ${detail}`);
    expect(agent.querySelector(".doing")).toBeNull();
  });

  it("a running seat keeps tool detail and elapsed time in its tooltip", async () => {
    const detail = "pnpm -s vitest run apps/server/test/backfill.test.ts --reporter=verbose";
    stub({
      rows: [
        crewRow({
          digest: {
            toolCalls: 1,
            turns: 1,
            lastEventAt: NOW,
            model: null,
            contextTokens: null,
            contextWindow: null,
            liveTool: { name: "Bash", since: NOW - 65_000, detail },
            tools: {},
            subagents: [],
            minuteTokens: [],
            turnUsage: [],
            background: [],
            compactions: 0,
          },
        }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("Quote cache");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".process-line, .doing")).toBeNull();
    expect(row.title).toContain("Bash 1:05 · pnpm -s vitest");
  });

  it("a waiting seat's PR row shows the PR chip and its title, from the repo's PRs", async () => {
    // as live data is: the seat's run records no PRs, the PR is only in the repo's PRs
    stub({
      rows: [
        seatRow({
          hudState: "waiting",
          review: { prNumber: 166, state: "draft" },
          ticketTitle: null,
          prs: [],
        }),
      ],
      prs: [prView({ number: 166, title: "Backfill the quote cache" })],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const row = agentRows(container)[0] as HTMLElement;
    const doing = row.querySelector(".ticket-cell") as HTMLElement;
    await waitFor(() =>
      expect(doing.textContent).toBe("#3349 · PR #166 · Backfill the quote cache"),
    );
    await waitFor(() =>
      expect(within(doing).getByRole("link", { name: "shop-app PR #166" })).toBeTruthy(),
    );
  });

  it("the hover title is the visible line, PR title included", async () => {
    stub({
      rows: [
        seatRow({
          hudState: "waiting",
          review: { prNumber: 166, state: "draft" },
          ticketTitle: null,
          prs: [],
        }),
      ],
      prs: [prView({ number: 166, title: "Backfill the quote cache" })],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const row = agentRows(container)[0] as HTMLElement;
    const doing = row.querySelector(".ticket-cell") as HTMLElement;
    await waitFor(() =>
      expect(doing.textContent).toBe("#3349 · PR #166 · Backfill the quote cache"),
    );
    expect(doing.title).toBe("#3349 · PR #166 · Backfill the quote cache");
  });

  it("the ticket line's hover text is the ticket's whole title", async () => {
    stub({
      rows: [
        seatRow({
          ticket: "shop-app#3349",
          ticketTitle: "Quote cache: refresh on a timer, never on read",
        }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const line = agentRows(container)[0]?.querySelector(".ticket-cell") as HTMLElement;
    expect(line.title).toBe("#3349 · Quote cache: refresh on a timer, never on read");
  });

  it("a seat with no ticket has its placeholder as hover text", async () => {
    stub({ rows: [seatRow({ ticket: null, ticketTitle: "Stale title" })] });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const line = agentRows(container)[0]?.querySelector(".ticket-cell") as HTMLElement;
    expect(line.getAttribute("title")).toBe("—");
  });

  it("while the repo's PRs load the line is the bare PR line, not the last text", async () => {
    const lastText = "I pushed the review fixes.";
    const digest = {
      toolCalls: 1,
      turns: 1,
      lastEventAt: NOW,
      model: null,
      contextTokens: null,
      contextWindow: null,
      liveTool: null,
      lastText,
      tools: {},
      subagents: [],
      minuteTokens: [],
      turnUsage: [],
      background: [],
      compactions: 0,
    };
    const f = stub({
      rows: [
        seatRow({
          hudState: "waiting",
          review: { prNumber: 166, state: "draft" },
          ticketTitle: null,
          digest,
        }),
      ],
      prs: [prView({ number: 166, title: "Backfill the quote cache" })],
    });
    // hold the repo's PRs back until the test lets them through
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input === "/api/repos/shop-app/prs?linked=1") await gate;
      return f(input, init);
    });
    const { container } = render(<Overview />);
    await screen.findByText("guido-1");
    const row = agentRows(container)[0] as HTMLElement;
    const doing = row.querySelector(".ticket-cell") as HTMLElement;
    await waitFor(() => expect(doing.textContent).toBe("#3349 · PR #166"));
    release();
    await waitFor(() =>
      expect(doing.textContent).toBe("#3349 · PR #166 · Backfill the quote cache"),
    );
  });

  it("the repo's PRs are kept for a seat with an open review, whatever its state, and not for a note", async () => {
    const review = { prNumber: 77, state: "open" } as const;
    const prsPath = "/api/repos/shop-app/prs?linked=1";
    const fetched = async (rows: CrewRow[]) => {
      const f = stub({ rows });
      const { unmount } = render(<Overview />);
      await screen.findByText(rows[0]?.id ?? "");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      unmount();
      return f.mock.calls.some(([p]) => p === prsPath);
    };
    expect(await fetched([seatRow({ hudState: "running", review })])).toBe(true);
    hub.clear();
    expect(await fetched([seatRow({ hudState: "idle", note: "Rate limited", review })])).toBe(
      false,
    );
    hub.clear();
    expect(await fetched([seatRow({ hudState: "idle", review: null })])).toBe(false);
  });

  it("shows ticket, title, tokens, rate, cost, ctx and the account's 5h window", async () => {
    const minute = Math.floor(NOW / MIN) * MIN;
    stub({
      rows: [
        crewRow({
          contextWindow: 1_000_000,
          digest: {
            toolCalls: 1,
            turns: 1,
            lastEventAt: NOW,
            model: null,
            contextTokens: 483_137,
            contextWindow: 1_000_000,
            liveTool: { name: "Bash", since: NOW - 65_000 },
            tools: {},
            subagents: [],
            minuteTokens: [
              [minute - 2 * MIN, 1500],
              [minute - MIN, 2400],
              [minute, 100],
            ],
            turnUsage: [],
            background: [],
            compactions: 0,
          },
        }),
      ],
      limits: [limit5h({ used: 82 }), limit7d()],
    });
    const { container } = render(<Overview />);
    await screen.findByText("Quote cache");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.textContent).toContain("#3349");
    expect(row.title).toContain("Bash");
    expect(row.querySelector(".process-line")).toBeNull();
    expect(row.querySelector('[title="observed loop · ta-loop"]')).toBeTruthy();
    expect(row.querySelector(".tok span[title]")?.getAttribute("title")).toContain(
      "Input 12.0k · Output 3.4k",
    );
    expect(row.textContent).toContain("133/min");
    expect(row.textContent).toContain("~$2.47");
    expect(row.textContent).toContain("ctx 48%");
    expect(row.textContent).toContain("82%");
    expect(row.querySelector(".spark")).toBeTruthy();
    expect(row.querySelector(".meter.hi")).toBeTruthy(); // 82 % is amber
  });

  it("a running row's cost is the live estimate", async () => {
    const base = crewRow().run as NonNullable<CrewRow["run"]>;
    stub({ rows: [crewRow({ run: { ...base, costEstimateUsd: 3.1 } })] });
    const { container } = render(<Overview />);
    await screen.findByText("Quote cache");
    const row = agentRows(container)[0] as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain("~$3.10"));
    expect(row.textContent).not.toContain("~$2.47");
  });

  it("sorts error before running before idle, agents with a need first", async () => {
    stub({
      rows: [
        crewRow({ id: "idle-one", index: 0, hudState: "idle" }),
        crewRow({ id: "run-one", index: 1, hudState: "running" }),
        crewRow({ id: "err-one", index: 2, hudState: "error", sourceError: "gone" }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("run-one");
    expect(agentRows(container).map((r) => r.querySelector(".ag")?.textContent)).toEqual([
      "err-one",
      "run-one",
      "idle-one",
    ]);
  });

  it("the stalled need line counts up with the 1 s clock", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    stub({
      rows: [crewRow({ hudState: "stalled", lastOutputAt: NOW - 11 * MIN })],
      items: [
        item({ key: "stall:1", kind: "stalled", at: NOW - 125_000, tool: "Bash", ticket: null }),
      ],
    });
    const { container } = render(<Overview />);
    const need = async () => (await screen.findByText(/^Stalled \d+:\d\d/)).textContent;
    expect(await need()).toBe("Stalled 2:05 in Bash");
    expect(container.querySelector(".need")?.textContent).toContain("observed loop");
    expect(container.querySelector(".need button")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(await need()).toBe("Stalled 2:08 in Bash");
  });

  it("a parked item shows its reason on a Blocked row; Answer opens the Item panel", async () => {
    stub({
      rows: [crewRow({ hudState: "blocked" })],
      items: [
        item({ key: "p:1", kind: "parked", text: "Needs a rebase decision", ticket: null }),
        item({ key: "esc:shop-app#4001", kind: "decision" }),
      ],
    });
    const { container } = render(
      <>
        <Overview />
        <Probe />
      </>,
    );
    await screen.findByText("Parked: Needs a rebase decision");
    expect(within(agentRows(container)[0] as HTMLElement).getByText("Blocked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByTestId("item").textContent).toBe("esc:shop-app#4001");
    expect(window.location.pathname).toBe("/"); // the row click did not also navigate
  });

  it("a set-aside run's ready note shows in Needs you, not as a lamp or need line on the seat's row", async () => {
    const ready = {
      ...item({ key: "ready:old", kind: "decision", ticket: "shop-app#3000", escalationId: null }),
      kind: "ready",
    } as unknown as AttentionItem;
    stub({ rows: [crewRow({ ticket: "shop-app#3349" })], items: [ready] });
    const { container } = render(<Overview />);
    await screen.findByText("Quote cache");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.classList.contains("needs")).toBe(false);
    expect(row.querySelector(".need")).toBeNull();
    expect(screen.queryByText("Ready to merge")).toBeNull();
    expect(container.querySelector("#nbanner .nbanner b.num")?.textContent).toBe("1");
  });

  it("a row is not a button around buttons:its call sign is the link to the Agent page", async () => {
    stub({
      rows: [crewRow({ hudState: "blocked" })],
      items: [item({ key: "esc:shop-app#4001", kind: "decision" })],
    });
    const { container } = render(<Overview />);
    await screen.findByRole("button", { name: "Answer" });
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.getAttribute("role")).toBe("row");
    expect(row.hasAttribute("tabindex")).toBe(false);
    const link = within(row).getByRole("link", { name: "shop-app-ta" });
    expect(link.getAttribute("href")).toBe("/agent/shop-app-ta");
    expect(link.contains(within(row).getByRole("button", { name: "Answer" }))).toBe(false);
  });

  it("a ticket link inside a row goes to GitHub and does not also open the Agent page", async () => {
    stub({ rows: [crewRow({ id: "shop-app-ta" })] });
    const { container } = render(<Overview />);
    await screen.findByText("Quote cache");
    const link = await within(agentRows(container)[0] as HTMLElement).findByRole("link", {
      name: "shop-app #3349",
    });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/3349");
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/");
  });

  it("clicking a row or its link opens the Agent page; the session filter hides other repos", async () => {
    stub({
      config: SESSION_CONFIG,
      rows: [
        crewRow({ id: "shop-app-ta" }),
        crewRow({ id: "studio", index: 1, repoId: "site-builder" }),
      ],
    });
    const { container } = render(<Overview />);
    await screen.findByText("studio");
    fireEvent.click(
      within(agentRows(container)[1] as HTMLElement).getByRole("link", { name: "studio" }),
    );
    expect(window.location.pathname).toBe("/agent/studio");
    act(() => window.history.pushState(null, "", "/"));
    fireEvent.click(within(agentRows(container)[0] as HTMLElement).getByText("Running"));
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
    act(() => setSession("shop-app-session"));
    expect(agentRows(container).map((r) => r.querySelector(".ag")?.textContent)).toEqual([
      "shop-app-ta",
    ]);
    expect(container.querySelector(".trow.flight")).toBeTruthy();
    expect(screen.getByText("1 working · 1 agents · FLIGHT not counted")).toBeTruthy();
  });
});

describe("Needs banner", () => {
  it("says All clear, with the away strip first when away mode is on", async () => {
    stub({ away: { on: true, until: "2026-10-28", may: {} } });
    const { container } = render(<NeedsBanner />);
    await screen.findByText("All clear");
    expect(screen.getByText("Nothing is waiting on you.")).toBeTruthy();
    expect(screen.getByText("Away mode is on until Wed 28 Oct.")).toBeTruthy();
    expect(container.querySelector(".awaystrip")?.nextElementSibling?.className).toContain("clear");
  });

  it("counts things by kind and goes to Comms", async () => {
    stub({
      items: [
        item({ key: "1", kind: "decision" }),
        item({ key: "2", kind: "decision" }),
        item({ key: "3", kind: "approval" }),
        item({ key: "4", kind: "question" }),
        item({ key: "5", kind: "stalled" }),
        item({ key: "6", kind: "error" }),
        item({ key: "7", kind: "parked" }),
        item({ key: "8", kind: "pr" }),
        item({ key: "9", kind: "stray" }),
        item({ key: "10", kind: "tag" }),
      ],
    });
    render(<NeedsBanner />);
    const btn = await screen.findByRole("button", { name: /things need you/ });
    expect(btn.textContent).toBe(
      "10things need you2 decisions2 approvals2 stalls1 message1 PR waiting on you1 parked1 stray change· 10 not acknowledgedOpen Comms →",
    );
    fireEvent.click(btn);
    expect(window.location.pathname).toBe("/comms");
  });
});

describe("Needs banner, acknowledged items", () => {
  it("still counts them, and says how many are not acknowledged", async () => {
    stubFetch({
      "/api/attention": [
        item({ key: "1", kind: "decision" }),
        item({ key: "2", kind: "decision", acked: true }),
        item({ key: "3", kind: "stalled", acked: true }),
      ],
      "/api/settings/away": { on: false },
    });
    render(<NeedsBanner />);
    const btn = await screen.findByRole("button", { name: /things need you/ });
    expect(btn.textContent).toBe(
      "3things need you2 decisions1 stall· 1 not acknowledgedOpen Comms →",
    );
  });

  it("counts only the operator's items; one with no owner counts", async () => {
    stubFetch({
      "/api/attention": [
        item({ key: "1" }),
        itemWithoutOwner({ key: "2" }),
        item({ key: "3", owner: "loop" }),
      ],
      "/api/settings/away": { on: false },
    });
    render(<NeedsBanner />);
    const btn = await screen.findByRole("button", { name: /things need you/ });
    expect(btn.textContent).toBe("2things need you2 decisions· 2 not acknowledgedOpen Comms →");
  });

  it("is all clear when every item is someone else's", async () => {
    stubFetch({
      "/api/attention": [item({ owner: "controller" })],
      "/api/settings/away": { on: false },
    });
    render(<NeedsBanner />);
    await screen.findByText("All clear");
  });

  it("adds nothing when every item is acknowledged", async () => {
    stubFetch({
      "/api/attention": [item({ acked: true })],
      "/api/settings/away": { on: false },
    });
    render(<NeedsBanner />);
    const btn = await screen.findByRole("button", { name: /thing/ });
    expect(btn.textContent).not.toContain("not acknowledged");
  });
});

describe("Machine panel: the test lock box", () => {
  const box = async () => {
    const { container } = render(<Overview />);
    return waitFor(() => {
      const box = container.querySelector("#machP .lock");
      expect(box).toBeTruthy();
      return box as HTMLElement;
    });
  };

  it("hides the test lock box when free with nobody waiting", async () => {
    const fetch = stub();
    const { container } = render(<Overview />);
    await settled(fetch, "/api/test-lock");
    expect(container.querySelector("#machP .lock")).toBeNull();
  });

  const HELD = {
    holder: { runId: "r-1", seatId: "guido-2", command: "pnpm -s test", since: NOW - 83_000 },
    waiting: [{ runId: "r-2", seatId: "guido-3", command: "pnpm -s test", since: NOW - 12_000 }],
  };
  const holder = (over: Partial<CrewRow> = {}) =>
    seatRow({ id: "guido-2", index: 1, ticket: "shop-app#3349", ...over });
  const waiter = () =>
    seatRow({ id: "guido-3", index: 2, ticket: "shop-app#3350", hudState: "idle" });

  it("held and running: the holder, its command, ticket and time, then the seats in line", async () => {
    stub({ rows: [holder({ hudState: "running" }), waiter()], lock: HELD });
    const b = await box();
    await within(b).findByText("Running");
    expect(within(b).getByText("pnpm -s test").className).toContain("chipref");
    expect(b.textContent).toContain("1:23 elapsed");
    expect(b.textContent).not.toContain("nothing printed");
    expect(b.className).not.toContain("pulse-warn");
    const [first] = b.querySelectorAll<HTMLElement>(".lockq");
    expect(first?.textContent).toContain("1");
    expect(first?.textContent).toContain("guido-3");
    expect(first?.textContent).toContain("3350");
    expect(first?.textContent).toContain("0:12");
    expect(b.textContent).not.toContain(LOCK_FREE_TEXT);
  });

  it("held by a stalled seat: No output, the quiet time, and Stop the run and Open", async () => {
    const fn = stub({
      rows: [holder({ hudState: "stalled", lastOutputAt: NOW - 5 * MIN }), waiter()],
      lock: HELD,
      extra: { "POST /api/seats/guido-2/interrupt": { ok: true } },
    });
    const b = await box();
    await within(b).findByText("No output");
    expect(b.textContent).toContain("1:23 elapsed · nothing printed for 5:00");
    expect(b.className).toContain("pulse-warn");
    fireEvent.click(within(b).getByRole("button", { name: "Stop the run" }));
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        "/api/seats/guido-2/interrupt",
        expect.objectContaining({ method: "POST", body: "{}" }),
      ),
    );
    fireEvent.click(within(b).getByRole("button", { name: "Open GUIDO-2" }));
    expect(window.location.pathname).toBe("/agent/guido-2");
  });

  it("shows queued seats even before there is a holder", async () => {
    stub({ rows: [waiter()], lock: { holder: null, waiting: HELD.waiting } });
    const b = await box();
    expect(b.querySelector(".lockq")?.textContent).toContain("guido-3");
    expect(b.querySelector(".lockq")?.textContent).toContain("0:12");
    expect(within(b).queryByRole("button", { name: "Stop the run" })).toBeNull();
  });

  it("held with nobody in line says so", async () => {
    stub({ rows: [holder()], lock: { ...HELD, waiting: [] } });
    const b = await box();
    await within(b).findByText(LOCK_NOBODY_WAITING);
    expect(within(b).queryByText("Waiting")).toBeNull();
  });
});

describe("Machine panel", () => {
  it("labels CPU, memory and disk, keeping the legend on hover", async () => {
    stub();
    const { container } = render(<Overview />);
    const mach = container.querySelector("#machP") as HTMLElement;
    await within(mach).findByText("37%");
    expect(mach.textContent).toContain("this Mac · every 2 s");
    expect(mach.textContent).toContain("37% of 16 threads");
    expect(mach.textContent).toContain("20.5 of 64 GB");
    expect(mach.textContent).toContain("412 GB free");
    expect(mach.querySelector(".res")?.getAttribute("title")).toContain(
      "Claude/Codex processes (3)",
    );
    expect(mach.querySelector(".res")?.getAttribute("title")).toContain("other apps");
    expect(mach.querySelector(".lock")).toBeNull();
    expect(mach.textContent).not.toMatch(/slots|Room for/i);
    // agents 80 % of 16 threads = 5 % of the machine; the rest is other apps
    const cpu = mach.querySelectorAll(".resrow")[0] as HTMLElement;
    const widths = [...cpu.querySelectorAll<HTMLElement>(".stack i")].map((i) => i.style.width);
    expect(widths).toEqual(["5%", "32.4%"]);
  });

  it("the agents row: 6 of 8 seats, up to 3 per session, room for 2 more", async () => {
    stub({ seats: { maxSeats: 8, seats: 6, perSessionMax: 3 } });
    const { container } = render(<Overview />);
    const mach = container.querySelector("#machP") as HTMLElement;
    const row = await waitFor(() => {
      const r = mach.querySelector<HTMLElement>(".agentslots");
      if (!r) throw new Error("no agents row");
      return r;
    });
    expect(mach.querySelectorAll(".slots i").length).toBe(8);
    expect(mach.querySelectorAll(".slots i.used").length).toBe(6);
    expect(row.textContent).toContain("6 of 8");
    expect(row.title).toContain("up to 3 per session");
    expect(row.title).toContain("Room for 2 more agents");
    expect(row.className).toContain("ok-t");
  });

  it("No room for another agent when every seat is used or 2 GB is free", async () => {
    stub({ seats: { maxSeats: 8, seats: 8, perSessionMax: 4 } });
    const first = render(<Overview />);
    const mach = first.container.querySelector("#machP") as HTMLElement;
    const msg = await within(mach).findByTitle(/No room for another agent/);
    expect(msg.className).toContain("warn-t");
    expect(mach.querySelectorAll(".slots i.used").length).toBe(8);
    cleanup();
    hub.clear();

    stub({
      seats: { maxSeats: 8, seats: 6, perSessionMax: 3 },
      machine: sample({ memUsedBytes: 62 * GIB }),
    });
    const second = render(<Overview />);
    const mach2 = second.container.querySelector("#machP") as HTMLElement;
    await within(mach2).findByTitle(/No room for another agent/);
    expect(mach2.textContent).not.toContain("Room for");
  });

  it("shows dashes and empty bars before the first sample", async () => {
    stub({ machine: null });
    const { container } = render(<Overview />);
    const mach = container.querySelector("#machP") as HTMLElement;
    await waitFor(() => expect(mach.querySelectorAll(".resrow").length).toBe(3));
    expect(mach.querySelectorAll(".stack i").length).toBe(0);
    for (const row of mach.querySelectorAll(".resrow")) expect(row.textContent).toContain("—");
    expect(mach.querySelector(".res")?.getAttribute("title")).toContain(
      "Claude/Codex processes (—)",
    );
  });

  it("a CPU not measured yet is —; zero cores is not '0 threads'", async () => {
    stub({ machine: sample({ cpuPct: null, cores: 0, agents: null, memUsedBytes: null }) });
    const { container } = render(<Overview />);
    const mach = container.querySelector("#machP") as HTMLElement;
    await waitFor(() => expect(mach.textContent).toContain("412 GB free"));
    const cpu = mach.querySelectorAll(".resrow")[0] as HTMLElement;
    expect(cpu.querySelectorAll(".stack i").length).toBe(0);
    expect(cpu.textContent).toContain("—");
    expect(mach.textContent).not.toContain("0 threads");
  });
});

describe("Account quota panel", () => {
  it("each account keeps its last reading time on hover", async () => {
    stub({
      limits: [
        limit5h({ accountId: "claude-main", sampledAt: NOW - 4 * MIN }),
        limit7d({ accountId: "claude-main", sampledAt: NOW - 9 * MIN }),
        limit7d({ accountId: "codex-main", sampledAt: NOW - 30_000 }),
      ],
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    await within(quota).findByTitle(/read 4 min ago/);
    const rows = quota.querySelectorAll(".quotarow");
    expect(rows[0]?.textContent).not.toContain("9 min");
    expect(rows[1]?.querySelector("[title]")?.getAttribute("title")).toContain("read just now");
  });

  it("shows the last successful quota and collector note while rate limited", async () => {
    stub({
      limits: [
        limit7d({ accountId: "claude-main", used: 86, sampledAt: NOW - 8 * HOUR, stale: true }),
      ],
      health: [
        {
          collector: "usage:claude-main",
          ok: false,
          error: "Usage endpoint rate limited",
          at: NOW,
          lastOkAt: NOW - 8 * HOUR,
        },
      ],
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    await within(quota).findByText("7d 86% · 8h ago");
    await waitFor(() =>
      expect(quota.querySelector('[title*="Usage endpoint rate limited"]')).toBeTruthy(),
    );
  });

  const limits = [
    limit5h({ accountId: "claude-main", used: 100, resetAt: NOW + 2 * HOUR }),
    limit7d({ accountId: "claude-main", used: 60, fullAt: null }),
    limit7d({ accountId: "codex-main", used: 69, fullAt: NOW + 3 * HOUR + 10 * MIN }),
  ];

  it("one row per account, hover titles, warnings and the rewritten note", async () => {
    stub({ limits });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    await within(quota).findByText("claude-main 5h at its limit until 15:00");
    expect(within(quota).getByText("claude-main 5h at its limit until 15:00").className).toContain(
      "crit-t",
    );
    expect(
      within(quota).getByText("codex-main 7d full in ~3h10 at this rate (resets Sun 19:00)"),
    ).toBeTruthy();
    const rows = quota.querySelectorAll(".quotarow");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("5h 100%");
    expect(rows[0]?.textContent).toContain("7d 60%");
    expect(rows[1]?.textContent).toContain("5h —");
    expect(
      quota.querySelector('[title^="claude-main 7d: 60% used · not filling at this rate"]'),
    ).toBeTruthy();
    expect(quota.querySelector(".meter.full")).toBeTruthy();
    expect(within(quota).getByText("Account quota").title).toContain(
      "Claude quota comes from the usage endpoint and from rate-limit events in the loops' transcripts; Codex from its app-server, or its latest session log when that is unavailable. Read every 30 min.",
    );
  });

  it("every slot shows used %, with reset time and date on hover", async () => {
    stub({
      limits: [
        limit5h({ accountId: "claude-main", used: 21, resetAt: NOW + 4 * HOUR + 20 * MIN }),
        limit7d({ accountId: "claude-main", used: 73, resetAt: Date.UTC(2026, 9, 28, 2, 0) }),
        limit7d({ accountId: "codex-main", used: 9, resetAt: Date.UTC(2026, 9, 29, 16, 22) }),
      ],
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    await waitFor(() => expect(quota.querySelectorAll(".quotarow").length).toBe(2));
    const rows = quota.querySelectorAll(".quotarow");
    expect(rows[0]?.querySelector('[title*="5h: 21%"]')?.getAttribute("title")).toContain(
      "resets 17:20",
    );
    expect(rows[0]?.querySelector('[title*="7d: 73%"]')?.getAttribute("title")).toContain(
      "resets Wed 28 Oct 02:00",
    );
    expect(rows[1]?.textContent).toContain("5h —");
    expect(rows[1]?.querySelector('[title*="7d: 9%"]')?.getAttribute("title")).toContain(
      "resets Thu 29 Oct 16:22",
    );
    // the none slot is shaped like a bar slot, and the 7d slots match across rows
    const slot = (r: Element | undefined, i: number) => r?.children[i];
    expect(slot(rows[1], 1)?.querySelector(".track")).toBeTruthy();
    expect(slot(rows[1], 2)?.children[0]?.className).toBe(slot(rows[0], 2)?.children[0]?.className);
    expect(slot(rows[1], 2)?.querySelectorAll("*").length).toBe(
      slot(rows[0], 2)?.querySelectorAll("*").length,
    );
  });

  it("a 5h bar's hover says too little history when paceReady is false, the pace when true", async () => {
    stub({
      limits: [
        limit5h({ accountId: "claude-main", used: 40, paceReady: false }),
        limit5h({ accountId: "codex-main", used: 40, paceReady: true, fullAt: NOW + 2 * HOUR }),
      ],
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    await waitFor(() =>
      expect(
        quota.querySelector('[title^="claude-main 5h: 40% used · too little history for a pace"]'),
      ).toBeTruthy(),
    );
    expect(quota.querySelector('[title^="codex-main 5h: 40% used · ~2h00"]')).toBeTruthy();
  });

  it("the GitHub row: what is left, the poll cost and the reset", async () => {
    stub({ limits, githubRate: GITHUB_RATE });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    expect(await within(quota).findByText(GITHUB_RATE_LINE)).toBeTruthy();
    expect(quota.textContent).not.toContain("slowed");
  });

  it("the GitHub row is — before any reading", async () => {
    stub({ limits });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    expect(await within(quota).findByText("GitHub API · —")).toBeTruthy();
  });

  it("shows the collector's slowed note beside the GitHub row", async () => {
    const note = `${GITHUB_SLOWED_PREFIX} rate limit low (400 left, resets 15:00)`;
    stub({
      limits,
      githubRate: GITHUB_RATE,
      health: [{ collector: "github:shop-app", ok: true, error: note, at: NOW, lastOkAt: NOW }],
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    const shown = await within(quota).findByText(note);
    expect(shown.getAttribute("role")).toBe("status");
  });

  it("shows the slowed note even when there is no reading yet", async () => {
    const note = `${GITHUB_SLOWED_PREFIX} rate limit low (400 left, resets 15:00)`;
    stub({
      limits,
      health: [{ collector: "github:shop-app", ok: true, error: note, at: NOW, lastOkAt: NOW }],
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    expect(await within(quota).findByText(note)).toBeTruthy();
    expect(within(quota).getByText("GitHub API · —")).toBeTruthy();
  });

  it("shows resets — once the reading's reset time has passed", async () => {
    const q = GITHUB_RATE.queries.escalations;
    if (!q) throw new Error("fixture has no escalations query");
    const expired = {
      ...GITHUB_RATE,
      queries: { escalations: { ...q, resetAt: NOW - MIN } },
    };
    stub({ limits, githubRate: expired });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    expect(
      await within(quota).findByText("GitHub API · 4750 left · 7 per poll · resets —"),
    ).toBeTruthy();
  });

  it("keeps the row — until the timezone has loaded", async () => {
    stubFetch({
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/limits": limits,
      "/api/limits/github": GITHUB_RATE,
      "/api/health": [],
      "/api/config": () => ({ status: 503, body: { error: "loading" } }),
    });
    const { container } = render(<Overview />);
    const { githubRate } = RESOURCES;
    await waitFor(() => expect(hub.snapshot(githubRate.path, githubRate.topic).data).toBeTruthy());
    // Re-query: the panel may have re-rendered since the reading landed.
    const quota = container.querySelector("#quotaP") as HTMLElement;
    expect(quota.querySelector(".githubrate")?.textContent).toBe("GitHub API · —");
    expect(quota.textContent).not.toContain("4750 left");
  });

  it("shows the reset in the operator's timezone", async () => {
    stub({
      limits,
      githubRate: GITHUB_RATE,
      config: { ...CONFIG, operator: { ...CONFIG.operator, timezone: "Asia/Tokyo" } },
    });
    const { container } = render(<Overview />);
    const quota = container.querySelector("#quotaP") as HTMLElement;
    expect(
      await within(quota).findByText("GitHub API · 4750 left · 7 per poll · resets 23:00"),
    ).toBeTruthy();
  });
});

describe("Activity panel", () => {
  it("with 120 rows, a replaced newest row scrolls the list to the bottom", async () => {
    const base: ActivityRow[] = Array.from({ length: 120 }, (_, i) => ({
      at: NOW - i * MIN,
      who: "studio",
      kind: "run-start",
      text: `event ${i}`,
      ref: null,
      url: null,
      status: null,
      prs: [],
      summary: null,
    }));
    let current: ActivityRow[] = base;
    // The refetch is a delta from the newest row's millisecond; answer it as the server does.
    const since = NOW - 1;
    stub({
      activityNow: () => current,
      extra: {
        [`/api/activity?since=${since}`]: () => ({
          status: 200,
          body: current.filter((r) => r.at > since),
        }),
      },
    });
    const { container } = render(<Overview />);
    await screen.findByText("event 0");
    const list = container.querySelector("#actList") as HTMLElement;
    let top = 0;
    Object.defineProperty(list, "scrollHeight", { get: () => 5000 });
    Object.defineProperty(list, "scrollTop", { get: () => top, set: (v: number) => (top = v) });
    top = 0;
    current = [{ ...(base[0] as ActivityRow), at: NOW + MIN, text: "newest event" }, ...current];
    act(() => {
      hub.refetch("/api/activity");
    });
    await screen.findByText("newest event");
    expect(top).toBe(5000);
    expect(container.querySelectorAll("#actList .arow").length).toBe(120);
  });

  const events: ActivityEvent[] = (
    [
      {
        at: NOW - MIN,
        who: "shop-app-ta",
        kind: "run-end",
        text: "run #11 failed",
        ref: null,
        url: null,
        status: "failed",
      },
      {
        at: NOW - 2 * MIN,
        who: "shop-app-ta",
        kind: "run-start",
        text: "run #11 started",
        ref: "shop-app#3349",
        url: null,
        status: null,
      },
      {
        at: NOW - 3 * MIN,
        who: "github:shop-app",
        kind: "collector",
        text: "github failed",
        ref: null,
        url: null,
        status: null,
      },
      {
        at: NOW - 4 * MIN,
        who: "studio",
        kind: "run-start",
        text: "studio run",
        ref: null,
        url: null,
        status: null,
      },
    ] satisfies Omit<ActivityEvent, "prs" | "summary">[]
  ).map((e) => ({ ...e, prs: [], summary: null }));
  const rows = [
    crewRow({ id: "shop-app-ta" }),
    crewRow({ id: "studio", index: 1, repoId: "site-builder" }),
  ];

  it("renders every row when events share their time, agent, kind and text", async () => {
    const twin = events[3] as ActivityEvent;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stub({ rows, activity: [twin, { ...twin }] });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findAllByText("studio run");
    expect(act_.querySelectorAll(".arow")).toHaveLength(2);
    expect(error).not.toHaveBeenCalled(); // React warns on a repeated key
    error.mockRestore();
  });

  it("lists oldest first with glyphs; failed ends and collectors are red", async () => {
    stub({ rows, activity: events });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText("run #11 failed");
    const arows = [...act_.querySelectorAll<HTMLElement>(".arow")];
    expect(arows.map((r) => r.querySelector(".txt")?.textContent)).toEqual([
      "studio studio run",
      "github:shop-app github failed",
      "shop-app-ta run #11 started",
      "shop-app-ta run #11 failed",
    ]);
    expect(arows[0]?.querySelector(".g")?.textContent).toBe("→");
    expect(arows[1]?.querySelector(".g")?.textContent).toBe("◆");
    expect(arows[1]?.querySelector(".g")?.className).toContain("crit-t");
    expect(arows[3]?.querySelector(".g")?.className).toContain("crit-t");
    expect(arows[2]?.querySelector(".g")?.className).not.toContain("crit-t");
    expect(arows[2]?.textContent).toContain("shop-app #3349");
    expect(act_.textContent).toContain("high-level steps from every agent");
  });

  it("Steps hides turn state rows but keeps stalled and commit rows; Everything shows all four", async () => {
    const base = { ref: null, url: null, status: null, prs: [], summary: null, who: "shop-app-ta" };
    const stalled = "Running → Stalled: no output for 10 min";
    const commit = "Committed abc1234: Cache quotes";
    const activity: ActivityEvent[] = [
      { ...base, at: NOW, kind: "state", text: SEAT_TURN_END_TEXT },
      { ...base, at: NOW - MIN, kind: "state", text: SEAT_TURN_START_TEXT },
      { ...base, at: NOW - 2 * MIN, kind: "state", text: stalled },
      { ...base, at: NOW - 3 * MIN, kind: "push", text: commit },
    ];
    stub({ rows, activity });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText(stalled);
    expect(within(act_).getByText(commit)).toBeTruthy();
    expect(within(act_).queryByText(SEAT_TURN_START_TEXT)).toBeNull();
    expect(within(act_).queryByText(SEAT_TURN_END_TEXT)).toBeNull();
    expect(act_.querySelectorAll(".arow")).toHaveLength(2);

    fireEvent.click(within(act_).getByRole("button", { name: "Everything" }));
    for (const { text } of activity) expect(within(act_).getByText(text)).toBeTruthy();
    expect(act_.querySelectorAll(".arow")).toHaveLength(4);
  });

  it("renders the check, commit, lock and guard kinds, and an unknown kind falls back", async () => {
    const base = { ref: null, url: null, status: null, prs: [], summary: null, who: "shop-app-ta" };
    const kinds = [
      ["check", "✓", "k-check"],
      ["commit", "●", "k-commit"],
      ["lock", "⊟", "k-lock"],
      ["guard", "⊘", "k-guard"],
      ["mystery", "◆", "k-step"],
    ] as const;
    const activity = kinds.map(([kind], i) => ({
      ...base,
      at: NOW - i * MIN,
      kind,
      text: `${kind} event`,
    })) as unknown as ActivityEvent[];
    stub({ rows, activity });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText("check event");
    for (const [kind, glyph, cls] of kinds) {
      const row = within(act_).getByText(`${kind} event`).closest(".arow") as HTMLElement;
      expect(row.className).toContain(cls);
      expect(row.querySelector(".g")?.textContent).toBe(glyph);
    }
  });

  // A regression guard: these pass without the turn-line filter too, and fail only if it widens.
  it("Steps keeps parked, error and woken state rows", async () => {
    const texts = ["Running → Parked", "Running → Error: exit 1", "Error → Idle (run #3 woken)"];
    const activity: ActivityEvent[] = texts.map((text, i) => ({
      ...(events[0] as ActivityEvent),
      at: NOW - i * MIN,
      kind: "state",
      status: null,
      text,
    }));
    stub({ rows, activity });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText(texts[0] as string);
    for (const text of texts) expect(within(act_).getByText(text)).toBeTruthy();
    expect(act_.querySelectorAll(".arow")).toHaveLength(3);
  });

  it("a run-end row ends with its summary and shows its PR chips after the ref", async () => {
    const ended: ActivityEvent = {
      ...(events[0] as ActivityEvent),
      text: "ok · shop-app#3349 · Cached quotes",
      ref: "shop-app#3349",
      summary: "Cached quotes",
      prs: [
        {
          repoId: "shop-app",
          number: 3240,
          title: "Quote cache",
          url: "https://github.com/octo-org/shop-app/pull/3240",
          state: "merged",
          ticket: "shop-app#3349",
        },
      ],
    };
    stub({ rows, activity: [ended] });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText(/Cached quotes/);
    const row = act_.querySelector(".arow") as HTMLElement;
    expect(row.querySelector(".txt")?.textContent?.endsWith(" · Cached quotes")).toBe(true);
    const chip = within(row).getByRole("link", { name: "shop-app PR #3240" });
    expect(chip.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/pull/3240");
    expect(row.textContent).toContain("#3349");
    expect(row.textContent).toContain("Merged");
  });

  it("renders state changes (red into error or stalled) and PR rows with the ⇡ glyph", async () => {
    const base = { ref: null, url: null, status: null, prs: [], summary: null };
    const list: ActivityEvent[] = [
      {
        ...base,
        at: NOW - MIN,
        who: "shop-app-ta",
        kind: "state",
        text: "Running → Stalled: no output for 10 min",
      },
      { ...base, at: NOW - 2 * MIN, who: "shop-app-ta", kind: "state", text: "Stalled → Running" },
      {
        ...base,
        at: NOW - 3 * MIN,
        who: "shop-app",
        kind: "pr-opened",
        text: "PR #41 opened: Quote cache",
        ref: "shop-app#3349",
        url: "https://github.com/octo-org/shop-app/pull/41",
      },
    ];
    stub({ rows, activity: list });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    const prLink = await within(act_).findByRole("link", { name: "shop-app PR #41" });
    expect(prLink.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/pull/41");
    expect(prLink.closest(".txt")?.textContent).toContain("PR #41 opened: Quote cache");
    const arows = [...act_.querySelectorAll<HTMLElement>(".arow")];
    const glyphs = arows.map((r) => r.querySelector(".g")?.textContent);
    expect(glyphs).toEqual(["⇡", "◆", "◆"]);
    expect(arows[0]?.querySelector(".g")?.className).not.toContain("crit-t");
    expect(arows[1]?.querySelector(".g")?.className).not.toContain("crit-t");
    expect(arows[2]?.querySelector(".g")?.className).toContain("crit-t");
    expect(
      within(arows[0] as HTMLElement).getByRole("link", { name: "shop-app #3349" }),
    ).toBeTruthy();
  });

  it("a move into Error reads red; a move out of Error does not", async () => {
    const base = { ref: null, url: null, status: null, prs: [], summary: null };
    const list: ActivityEvent[] = [
      {
        ...base,
        at: NOW - 2 * MIN,
        who: "shop-app-ta",
        kind: "state",
        text: "Running → Error: exit 1",
      },
      { ...base, at: NOW - MIN, who: "shop-app-ta", kind: "state", text: "Error → Idle" },
    ];
    stub({ rows, activity: list });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await waitFor(() => expect(act_.querySelectorAll(".arow").length).toBe(2));
    const glyph = (text: string) =>
      within(act_).getByText(text).closest(".arow")?.querySelector(".g")?.className;
    expect(glyph("Running → Error: exit 1")).toContain("crit-t");
    expect(glyph("Error → Idle")).not.toContain("crit-t");
  });

  it("a failed board move reads red; a successful one does not", async () => {
    const base = { ref: null, url: null, status: null, prs: [], summary: null, kind: "board" };
    const list = [
      { ...base, at: NOW - MIN, who: "shop-app", text: "shop-app#7 moved to In progress" },
      { ...base, at: NOW - 2 * MIN, who: "shop-app", text: "shop-app#8 move failed: HTTP 502" },
    ] as ActivityEvent[];
    stub({ rows, activity: list });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText(/move failed: HTTP 502/);
    const arows = [...act_.querySelectorAll<HTMLElement>(".arow")];
    expect(arows).toHaveLength(2);
    // oldest first: the failed move, then the successful one
    expect(arows[0]?.querySelector(".g")?.className).toContain("crit-t");
    expect(arows[0]?.querySelector(".txt .crit-t")).not.toBeNull();
    expect(arows[1]?.querySelector(".g")?.className).not.toContain("crit-t");
    expect(arows[1]?.querySelector(".txt .crit-t")).toBeNull();
  });

  describe("refs in the server's text", () => {
    const base = { ref: null, url: null, status: null, prs: [], summary: null, who: "shop-app-ta" };
    const show = async (list: ActivityEvent[]) => {
      stub({ rows, activity: list });
      const { container } = render(<Overview />);
      const act_ = container.querySelector("#actP") as HTMLElement;
      await within(act_).findAllByRole("link");
      return [...act_.querySelectorAll<HTMLElement>(".arow")];
    };

    it("a run's ref in its text is one linked chip, not text and a second chip", async () => {
      const arows = await show([
        {
          ...base,
          at: NOW - MIN,
          kind: "run-start",
          text: "started on shop-app#3349",
          ref: "shop-app#3349",
        },
        {
          ...base,
          at: NOW - 2 * MIN,
          kind: "run-end",
          text: "ok · shop-app#3349 · ≈$1.20 · Cached shop-app#3349 quotes",
          ref: "shop-app#3349",
        },
      ]);
      expect(arows.map((r) => r.querySelector(".txt")?.textContent)).toEqual([
        "shop-app-ta ok · shop-app #3349 · ≈$1.20 · Cached shop-app#3349 quotes",
        "shop-app-ta started on shop-app #3349",
      ]);
      for (const r of arows) {
        const links = within(r).getAllByRole("link", { name: "shop-app #3349" });
        expect(links).toHaveLength(1);
        expect(links[0]?.getAttribute("href")).toBe(
          "https://github.com/octo-org/shop-app/issues/3349",
        );
      }
    });

    it("a PR event's repo is the ticket's, else the URL's, before the agent's", async () => {
      const arows = await show([
        {
          ...base,
          at: NOW - MIN,
          kind: "pr-opened",
          text: "PR #9 opened: From the ticket",
          ref: "site-builder#12",
        },
        {
          ...base,
          at: NOW - 2 * MIN,
          kind: "pr-merged",
          text: "PR #41 merged: From the URL",
          url: "https://github.com/octo-org/site-builder/pull/41",
        },
        { ...base, at: NOW - 3 * MIN, kind: "pr-opened", text: "PR #5 opened: From the agent" },
      ]);
      const hrefs = arows.map((r) =>
        within(r)
          .getByRole("link", { name: /PR #\d+$/ })
          .getAttribute("href"),
      );
      expect(hrefs).toEqual([
        "https://github.com/octo-org/shop-app/pull/5",
        "https://github.com/octo-org/site-builder/pull/41",
        "https://github.com/octo-org/site-builder/pull/9",
      ]);
    });

    it("the ticket ref on a PR event links to the issue, not the PR's URL", async () => {
      const [row] = await show([
        {
          ...base,
          at: NOW - MIN,
          kind: "pr-opened",
          text: "PR #41 opened: Quote cache",
          ref: "shop-app#3349",
          url: "https://github.com/octo-org/shop-app/pull/41",
        },
      ]);
      const ticket = within(row as HTMLElement).getByRole("link", { name: "shop-app #3349" });
      expect(ticket.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/3349");
    });

    it("before the config loads, a ref is text, never the PR's URL", async () => {
      stub({
        rows,
        config: () => ({ status: 503, body: { error: "loading" } }),
        activity: [
          {
            ...base,
            at: NOW - MIN,
            kind: "pr-opened",
            text: "PR #41 opened: Quote cache",
            ref: "shop-app#3349",
            url: "https://github.com/octo-org/shop-app/pull/41",
          },
        ],
      });
      const { container } = render(<Overview />);
      const act_ = container.querySelector("#actP") as HTMLElement;
      await within(act_).findByText(/Quote cache/);
      expect(within(act_).queryByRole("link")).toBeNull();
    });

    it("an agent-less PR row does not say the repo twice", async () => {
      const [row] = await show([
        { ...base, at: NOW - MIN, who: "shop-app", kind: "pr-opened", text: "PR #5 opened: Q" },
      ]);
      expect((row as HTMLElement).querySelector(".txt .rchip")).toBeNull();
      expect((row as HTMLElement).querySelector(".txt")?.textContent).toBe(
        "shop-app PR #5 opened: Q",
      );
    });
  });

  const TAG = "@" + "CAPCOM";
  const comms = (over: Partial<CommsEvent> = {}): CommsEvent => ({
    at: NOW,
    kind: "comms",
    who: "guido-1",
    to: "CAPCOM",
    text: "x",
    ref: null,
    url: null,
    status: null,
    prs: [],
    summary: null,
    ...over,
  });

  it("Messages lists hand-offs FROM → TO; Steps hides them; Everything shows all; Pause freezes", async () => {
    const f = stub({
      rows: [...rows, seatRow({ index: 2 })],
      activity: [
        ...events.slice(0, 1),
        comms({ at: NOW - 2 * MIN, text: `Need a call ${TAG}`, ref: "shop-app#3349" }),
        comms({
          at: NOW - 3 * MIN,
          who: "MC",
          to: "guido-1",
          text: "CI failed on lint",
          ref: "shop-app#3349",
        }),
        ...events.slice(1),
      ],
    });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText("run #11 failed");
    expect(act_.querySelectorAll(".arow").length).toBe(4);
    expect(act_.textContent).not.toContain("CI failed on lint");
    fireEvent.click(within(act_).getByRole("button", { name: "Messages" }));
    const msgs = [...act_.querySelectorAll<HTMLElement>(".arow.k-comms")];
    expect(act_.querySelectorAll(".arow").length).toBe(2);
    const [mc, you] = msgs as [HTMLElement, HTMLElement];
    for (const part of ["Mission Control", "→", "guido-1", "CI failed on lint"]) {
      expect(mc.textContent, part).toContain(part);
    }
    expect(mc.querySelector(".g")?.textContent).toBe("›");
    expect(within(mc).getByRole("link").getAttribute("href")).toMatch(/\/issues\/3349$/);
    for (const part of ["guido-1", "→", "You"]) expect(you.textContent, part).toContain(part);
    expect(you.querySelector(".mention")?.textContent).toBe(TAG);
    expect(act_.textContent).toContain("what agents said to each other");
    expect(act_.textContent).not.toContain("Arrives with the engine (phase 2).");
    fireEvent.click(within(act_).getByRole("button", { name: "Everything" }));
    expect(act_.textContent).toContain("every event");
    expect(act_.querySelectorAll(".arow").length).toBe(6);
    expect(f).toHaveBeenCalled();
    fireEvent.click(within(act_).getByRole("button", { name: "Pause" }));
    expect(within(act_).getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("a comms row between agents of another session is hidden", async () => {
    stub({
      rows: [
        ...rows,
        seatRow({ id: "inco-1", index: 2, repoId: "site-builder", sessionId: "s2" }),
        seatRow({ index: 3 }),
      ],
      activity: [
        comms({ at: NOW - MIN, who: "inco-1", text: "site talk" }),
        comms({ at: NOW - 2 * MIN, text: "shop talk" }),
        comms({ at: NOW - 3 * MIN, who: "MC", text: "hub talk" }),
        comms({ at: NOW - 4 * MIN, who: "MC", to: "inco-1", text: "site ci" }),
        comms({ at: NOW - 5 * MIN, who: "guido-1", to: "inco-1", text: "cross talk" }),
      ],
    });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    fireEvent.click(within(act_).getByRole("button", { name: "Messages" }));
    await within(act_).findByText("site talk");
    act(() => setSession("s1"));
    expect(within(act_).getByText("shop talk")).toBeTruthy();
    expect(within(act_).getByText("hub talk")).toBeTruthy();
    expect(within(act_).queryByText("site talk")).toBeNull();
    expect(within(act_).queryByText("site ci")).toBeNull();
    expect(within(act_).getByText("cross talk")).toBeTruthy();
  });

  it("an empty Messages list says No events yet.", async () => {
    stub({ rows, activity: events });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText("run #11 failed");
    fireEvent.click(within(act_).getByRole("button", { name: "Messages" }));
    expect(within(act_).getByText("No events yet.")).toBeTruthy();
  });

  it("hides other repos' rows under a session filter", async () => {
    stub({ rows, activity: events, config: SESSION_CONFIG });
    const { container } = render(<Overview />);
    const act_ = container.querySelector("#actP") as HTMLElement;
    await within(act_).findByText("run #11 failed");
    act(() => setSession("shop-app-session"));
    expect(within(act_).queryByText("studio run")).toBeNull();
    expect(within(act_).getByText("run #11 started")).toBeTruthy();
    expect(within(act_).getByText("github failed")).toBeTruthy(); // names the repo, so it is shop-app's
  });

  it("an empty day says No events yet.", async () => {
    stub({ activity: [] });
    const { container } = render(<Overview />);
    await within(container.querySelector("#actP") as HTMLElement).findByText("No events yet.");
  });
});

describe("Overview: agent text is formatted", () => {
  const ev = (text: string): ActivityEvent => ({
    at: NOW - MIN,
    who: "shop-app-ta",
    kind: "run-start",
    text,
    ref: null,
    url: null,
    status: null,
    prs: [],
    summary: null,
  });

  it("an Activity row and a Parked need part render Markdown", async () => {
    stub({
      rows: [crewRow({ hudState: "blocked" })],
      items: [
        item({ key: "p:1", kind: "parked", text: "wait for **the operator**", ticket: null }),
      ],
      activity: [ev("ran `pnpm test` on **main**")],
    });
    const { container } = render(<Overview />);
    await screen.findByText("main");
    const row = container.querySelector(".arow .txt") as HTMLElement;
    expect(row.querySelector("code")?.textContent).toBe("pnpm test");
    expect(row.querySelector("strong")?.textContent).toBe("main");
    expect(row.textContent).not.toContain("**");
    const need = container.querySelector(".need") as HTMLElement;
    expect(need.querySelector("strong")?.textContent).toBe("the operator");
    expect(need.textContent).toContain("Parked: wait for the operator");
  });

  it.each(["__init__.py", "a*b", "1.", "-"])("plain prose %j is unchanged", async (text) => {
    stub({
      rows: [crewRow({ hudState: "blocked" })],
      items: [item({ key: "p:1", kind: "parked", text, ticket: null })],
      activity: [ev(text)],
    });
    const { container } = render(<Overview />);
    await screen.findByText(`Parked: ${text}`);
    const row = container.querySelector(".arow .txt") as HTMLElement;
    // the row is the agent tag, then the event text on its own
    expect(row.lastElementChild?.textContent).toBe(text);
    expect(row.querySelector("strong, code, em")).toBeNull();
  });

  it("keeps an Activity row and a need part to one line: a list marker is not a list", async () => {
    stub({
      rows: [crewRow({ hudState: "blocked" })],
      items: [item({ key: "p:1", kind: "parked", text: "1. retry", ticket: null })],
      activity: [ev("1. retry")],
    });
    const { container } = render(<Overview />);
    await screen.findByText("Parked: 1. retry");
    const row = container.querySelector(".arow .txt") as HTMLElement;
    expect(row.lastElementChild?.textContent).toBe("1. retry");
    expect(row.querySelector("p, ul, ol, pre, .md")).toBeNull();
    const need = container.querySelector(".need") as HTMLElement;
    expect(need.querySelector("p, ul, ol, pre, .md")).toBeNull();
  });
});

describe("Overview: what a seat is doing", () => {
  const ci = { phase: "ci" as const, text: "CI on 08a7cfc", prNumber: 9, parked: null };

  it("a seat with an ended run is Free, keeps its work reference, and has no loop step", async () => {
    const live = seatRow().run as NonNullable<CrewRow["run"]>;
    stub({
      rows: [
        seatRow({
          hudState: "idle",
          run: { ...live, status: "ok", endedAt: 1 },
          loop: { phase: "done", text: "Done · PR #9", prNumber: 9, parked: null },
        }),
      ],
    });
    const { container } = render(<Overview />);
    // the lock box says "Free" too, so look in the seat's row
    const row = await waitFor(() => {
      const el = agentRows(container)[0] as HTMLElement;
      expect(within(el).getByText("Free")).toBeTruthy();
      return el;
    });
    expect(row.querySelector(".ticket-cell")?.textContent).toBe("last #3349 · PR #9");
    expect(row.textContent).not.toContain("Quote cache");
    expect(row.querySelector(".doing")).toBeNull();
    expect(row.querySelector(".loopstep .stepbar")).toBeNull();
    expect(row.textContent).not.toContain("Done");
  });

  it("a seat in CI says Waiting on CI and the loop's text", async () => {
    stub({ rows: [seatRow({ hudState: "idle", loop: ci })] });
    const { container } = render(<Overview />);
    await screen.findByText("Waiting on CI");
    const row = agentRows(container)[0] as HTMLElement;
    expect(row.querySelector(".pill")?.textContent).toBe("Waiting on CI");
    expect(row.querySelector(".state-cell")?.textContent).toContain("25m");
    expect(row.title).toBe("CI on 08a7cfc");
    expect(row.textContent).toContain("Quote cache");
  });
});
