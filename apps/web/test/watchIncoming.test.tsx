import type { FlightArrivalDisposition, FlightWatchEntry } from "@mc/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { WatchList } from "../src/flight/Brief.tsx";
import { Drafts } from "../src/flight/Drafts.tsx";
import { Incoming } from "../src/flight/Incoming.tsx";
import { resetSession, setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { readStyles } from "./styles.ts";

const watch: FlightWatchEntry = {
  id: "hold",
  state: "warn",
  title: "Suite waiting",
  detail: "No output",
  catchUp: { kind: "new", line: "Two seats waiting" },
  next: "Check the suite",
  action: { kind: "lock-hold", runId: "run", toolUseId: "tool", since: 10 },
};
afterEach(() => {
  hub.clear();
  resetSession();
  vi.unstubAllGlobals();
});
it("shows recorded outcomes, newest first, without deriving them from Ready or an empty action", async () => {
  const entries = ["Queued", "No action", "Assigned", "Unrecognised"].map((outcome, i) => ({
    id: String(i),
    source: "Board",
    arrivalId: "demo#7",
    repoId: "demo",
    sourceRef: { kind: "github-issue", url: "https://github.com/example/demo/issues/7" },
    version: "1",
    arrivedAt: i,
    at: i,
    outcome,
    text: `Arrival ${i}`,
    detail: `Reason ${i}`,
  }));
  stubFetch({
    "/api/flight/incoming": { entries },
    "/api/repos": [{ id: "demo", github: "example/demo" }],
    "/api/boards/demo": [{ issueNumber: 7, status: "Ready" }],
  });
  render(<Incoming />);
  const rows = await screen.findAllByTestId("incoming-row");
  expect(rows).toHaveLength(4);
  expect(rows.map((r) => r.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Queued"),
      expect.stringContaining("No action"),
    ]),
  );
  expect(rows[0]?.textContent).toContain("Unrecognised");
  expect(rows[0]?.textContent).not.toContain("Assigned");
  expect(rows[1]?.textContent).toContain("Assigned");
  expect(rows[1]?.textContent).toContain("Reason 2");
  expect(screen.getAllByRole("link")[0]?.getAttribute("href")).toContain("/issues/7");
  act(() => setSession("missing"));
  await waitFor(() => expect(screen.queryAllByTestId("incoming-row")).toHaveLength(0));
});
it("updates watch rows with the hold and stops only on activation, reporting refusals", async () => {
  let lock = {
    holder: { runId: "run", seatId: "seat", since: 10, command: "suite" },
    waiting: [{ runId: "other", seatId: "other", since: 11, command: "suite" }],
  };
  const fetch = stubFetch({
    "/api/flight/brief": { session: "demo", sections: [], watch: [watch] },
    "/api/test-lock": () => ({ status: 200, body: lock }),
    "/api/crew?shape=summary": { rows: [{ id: "seat", hudState: "stalled" }] },
    "POST /api/seats/seat/end": () => ({ status: 409, body: { error: "Target changed" } }),
  });
  render(<WatchList />);
  const button = await screen.findByRole("button", { name: "Stop the run" });
  expect(screen.getByText("Next: Check the suite")).toBeTruthy();
  expect(screen.getByText("Two seats waiting")).toBeTruthy();
  expect(screen.getByText("New").className).toBe("pill plain");
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button, { detail: 0 });
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([p, init]) =>
          p === "/api/seats/seat/end" &&
          init?.body ===
            JSON.stringify({ watch: { id: "hold", runId: "run", toolUseId: "tool", since: 10 } }),
      ),
    ).toBe(true),
  );
  expect((await screen.findByRole("alert")).textContent).toBe("Target changed");
  lock = { ...lock, waiting: [] };
  act(() => hub.refetchTopic("guard"));
  await waitFor(() => expect(screen.queryByText("Suite waiting")).toBeNull());
});
it("focuses the matching draft only on click and keeps unknown actions inert", async () => {
  const draft = {
    id: 2,
    target: "demo#7",
    kind: "issue",
    text: "Prepared response",
    state: "pending",
    createdAt: 1,
  };
  stubFetch({
    "/api/flight/brief": {
      session: "demo",
      sections: [],
      watch: [
        { ...watch, id: "draft", action: { kind: "draft", draftId: 2, target: "demo#7" } },
        { ...watch, id: "future", title: "Future action", action: { kind: "future" } },
      ],
    },
    "/api/drafts": [draft],
  });
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  render(
    <>
      <WatchList />
      <Drafts />
    </>,
  );
  const button = await screen.findByRole("button", { name: "See draft" });
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(button, { detail: 0 });
  expect(scroll).toHaveBeenCalled();
  expect(document.activeElement?.textContent).toContain("Prepared response");
  expect(screen.getAllByRole("button", { name: "See draft" })).toHaveLength(1);
  expect(screen.getByText("Future action")).toBeTruthy();
});
it("shows loading, empty and failed responses", async () => {
  stubFetch({
    "/api/flight/incoming": { entries: [] },
    "/api/flight/brief": { session: "demo", sections: [], watch: [] },
  });
  const view = render(
    <>
      <Incoming />
      <WatchList />
    </>,
  );
  expect(screen.getByText("Loading arrivals…")).toBeTruthy();
  expect(screen.getByText("Loading revisit triggers…")).toBeTruthy();
  await screen.findByText("Nothing has arrived yet.");
  await screen.findByText("FLIGHT is not watching anything yet.");
  view.unmount();
  hub.clear();
  stubFetch({
    "/api/flight/incoming": () => ({ status: 500, body: { error: "Incoming unavailable" } }),
    "/api/flight/brief": () => ({ status: 500, body: { error: "Watch unavailable" } }),
  });
  render(
    <>
      <Incoming />
      <WatchList />
    </>,
  );
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
});

it("keeps long arrival and watch text readable in the narrow single-column layout", () => {
  const css = readStyles();
  // Needs you's groups stack into one column when the page is too narrow for three.
  expect(css).toMatch(
    /@container flight \(width < 900px\)[\s\S]*?\.flight-needs-groups,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
  );
  expect(css).toMatch(/\.watch-row \.min0,\s*\.incoming-row\s*\{\s*overflow-wrap: anywhere/);
  expect(css).toMatch(/\.row \{[^}]*flex-wrap: wrap/);
});
it("uses the exact outcome words and catalogue tones for all dispositions", async () => {
  const outcomes = [
    "Asked of you",
    "Assigned",
    "Raised to you",
    "Reply drafted",
    "Queued",
    "Watching",
    "No action",
    "Unknown",
  ];
  stubFetch({
    "/api/flight/incoming": {
      entries: outcomes.map((outcome, i) => ({
        id: String(i),
        source: "Board",
        arrivalId: "demo#7",
        version: "1",
        arrivedAt: i,
        at: i,
        outcome,
        text: `Item ${i}`,
        detail: "Recorded reason",
      })),
    },
  });
  render(<Incoming />);
  await screen.findAllByTestId("incoming-row");
  for (const outcome of outcomes) {
    const tone =
      outcome === "Assigned"
        ? "ok"
        : ["Asked of you", "Raised to you", "Watching"].includes(outcome)
          ? "warn"
          : "plain";
    expect(screen.getByText(outcome).className).toBe(`pill ${tone}`);
  }
});
it("preserves source destinations and refuses unsafe URLs", async () => {
  const entries = ["GitHub", "Teams", "GitHub"].map((source, i) => ({
    id: String(i),
    source,
    arrivalId: String(i),
    repoId: "demo",
    sourceRef: {
      kind: source === "Teams" ? "teams" : "github-pr",
      url: [
        "https://github.com/example/demo/pull/7",
        "https://teams.microsoft.com/l/message/demo",
        "javascript:alert(1)",
      ][i],
    },
    version: "1",
    arrivedAt: i,
    at: i,
    outcome: "No action",
    text: `Source ${i}`,
    detail: "Recorded reason",
  }));
  const urls = [
    "https://github.com/example/demo/pull/7",
    "https://teams.microsoft.com/l/message/demo",
    "javascript:alert(1)",
  ];
  stubFetch({
    "/api/flight/incoming": { entries },
    "/api/notifications": {
      open: urls.map((url, i) => ({ id: String(i), repoId: "demo", url })),
      handledToday: [],
    },
  });
  render(<Incoming />);
  expect((await screen.findByRole("link", { name: "Source 0" })).getAttribute("href")).toBe(
    urls[0],
  );
  expect(screen.getByRole("link", { name: "Source 1" }).getAttribute("href")).toBe(urls[1]);
  expect(screen.queryByRole("link", { name: "Source 2" })).toBeNull();
});

it.each(["GitHub", "Teams"])(
  "does not guess an issue URL for a handled %s arrival",
  async (source) => {
    stubFetch({
      "/api/flight/incoming": {
        entries: [
          {
            id: "record",
            source,
            arrivalId: "thread",
            version: "1",
            arrivedAt: 1,
            at: 1,
            outcome: "No action",
            text: "Handled source",
            detail: "Recorded reason",
          },
        ],
      },
      "/api/repos": [{ id: "demo", github: "example/demo" }],
      "/api/notifications": {
        open: [],
        handledToday: [{ id: "thread", repoId: "demo", number: 7 }],
      },
    });
    render(<Incoming />);
    await screen.findByText("Handled source");
    expect(screen.queryByRole("link", { name: "Handled source" })).toBeNull();
  },
);

it("rejects a GitHub URL for a Teams arrival", async () => {
  stubFetch({
    "/api/flight/incoming": {
      entries: [
        {
          id: "record",
          source: "Teams",
          arrivalId: "thread",
          version: "1",
          arrivedAt: 1,
          at: 1,
          outcome: "No action",
          text: "Teams source",
          repoId: "demo",
          sourceRef: { kind: "teams", url: "https://github.com/example/demo/issues/7" },
          detail: "Recorded reason",
        },
      ],
    },
    "/api/notifications": {
      open: [{ id: "thread", repoId: "demo", url: "https://github.com/example/demo/issues/7" }],
      handledToday: [],
    },
  });
  render(<Incoming />);
  await screen.findByText("Teams source");
  expect(screen.queryByRole("link", { name: "Teams source" })).toBeNull();
});

it.each(["guard", "agents"] as const)(
  "recovers a server-filtered watch row on %s updates without activating it",
  async (topic) => {
    let blocked = false;
    const fetch = stubFetch({
      "/api/flight/brief": () => ({
        status: 200,
        body: { session: "demo", sections: [], watch: blocked ? [watch] : [] },
      }),
      "/api/test-lock": () => ({
        status: 200,
        body: {
          holder: { runId: "run", seatId: "seat", since: 10, command: "suite" },
          waiting:
            blocked || topic === "agents"
              ? [{ runId: "other", seatId: "other", since: 11, command: "suite" }]
              : [],
        },
      }),
      "/api/crew?shape=summary": () => ({
        status: 200,
        body: {
          rows: [{ id: "seat", hudState: blocked || topic === "guard" ? "stalled" : "working" }],
        },
      }),
    });
    render(<WatchList />);
    await screen.findByText("FLIGHT is not watching anything yet.");
    blocked = true;
    act(() => hub.refetchTopic(topic));
    await screen.findByRole("button", { name: "Stop the run" });
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/flight/brief").length,
    ).toBeGreaterThan(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  },
);

const storedArrival: FlightArrivalDisposition = {
  id: "stored",
  source: "GitHub",
  arrivalId: "expired-thread",
  version: "1",
  repoId: "demo",
  sourceRef: null,
  arrivedAt: 1,
  at: 1,
  outcome: "No action",
  text: "Stored arrival",
  detail: "Recorded reason",
};

it("keeps arrivals in their stored repo after handled notifications expire", async () => {
  stubFetch({
    "/api/flight/incoming": {
      entries: [
        storedArrival,
        { ...storedArrival, id: "other", repoId: "other", text: "Other repo" },
      ],
    },
    "/api/config": {
      operator: { timezone: "UTC" },
      crew: { sessions: [{ id: "session", repoId: "demo" }] },
    },
    "/api/notifications": { open: [], handledToday: [] },
  });
  setSession("session");
  render(<Incoming />);
  await screen.findByText("Stored arrival");
  expect(screen.queryByText("Other repo")).toBeNull();
  expect(screen.getAllByTestId("incoming-row")).toHaveLength(1);
});

it.each([
  ["github-pr", "https://github.com/example/demo/pull/7"],
  ["github-issue", "https://github.com/example/demo/issues/7"],
  ["teams", "https://teams.microsoft.com/l/message/demo"],
] as const)("links a stored %s destination without notifications", async (kind, url) => {
  stubFetch({
    "/api/flight/incoming": {
      entries: [
        {
          ...storedArrival,
          source: kind === "teams" ? "Teams" : "GitHub",
          sourceRef: { kind, url },
        },
      ],
    },
    "/api/notifications": { open: [], handledToday: [] },
  });
  render(<Incoming />);
  expect((await screen.findByRole("link", { name: "Stored arrival" })).getAttribute("href")).toBe(
    url,
  );
});

it("keeps legacy arrivals plain even when a notification has a URL or a Board id names an issue", async () => {
  stubFetch({
    "/api/flight/incoming": {
      entries: [
        storedArrival,
        {
          ...storedArrival,
          id: "board",
          source: "Board",
          arrivalId: "demo#7",
          text: "Legacy Board",
        },
      ],
    },
    "/api/repos": [{ id: "demo", github: "example/demo" }],
    "/api/notifications": {
      open: [
        { id: "expired-thread", repoId: "demo", url: "https://github.com/example/demo/pull/7" },
      ],
      handledToday: [],
    },
  });
  render(<Incoming />);
  await screen.findByText("Stored arrival");
  expect(screen.queryByRole("link", { name: "Stored arrival" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Legacy Board" })).toBeNull();
});
