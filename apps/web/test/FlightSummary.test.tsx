import type { FlightScheduleView } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { Summary } from "../src/flight/Summary.tsx";
import { dayMonth, hhmm } from "../src/fmt.ts";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG, MIN, NOW } from "./fixtures.ts";
import { flightLedger, flightSummary, ledgerEntry, summaryItem } from "./flightSummaryFixture.ts";

afterEach(() => vi.unstubAllGlobals());

const entries = [6, 2, 4, 1, 5, 3].map((n) =>
  ledgerEntry({ key: `work:${n}`, title: `Work ${n}` }),
);
const watch = [1, 2, 3, 4, 5, 6].map((n) =>
  ledgerEntry({ key: `watch:${n}`, kind: "watch", title: `Watch ${n}`, status: "blocked" }),
);
const commitment = ledgerEntry({
  key: "promise:1",
  kind: "commitment",
  title: "Send the report",
  due: NOW + MIN,
});
const incoming = ledgerEntry({
  key: "incoming:1",
  kind: "incoming",
  title: "New request",
  status: "done",
  outcome: "Handled",
});
const completed = ledgerEntry({
  key: "work:done",
  title: "Shipped work",
  status: "done",
  outcome: "Merged",
});
const schedule: FlightScheduleView = {
  session: "s1",
  entries: [
    {
      id: "plan:1",
      title: "Check the PR",
      label: "Check the PR",
      kind: "PR recheck",
      target: "PR #25",
      status: "pending",
      dueAt: NOW + 2 * MIN,
      at: NOW + 2 * MIN,
      createdAt: NOW,
      minutesFromNow: 2,
      overdue: false,
      detail: "Check CI",
    },
  ],
};
const summary = flightSummary({
  now: entries.map(summaryItem),
  watching: { ...flightSummary().watching, top: watch.map(summaryItem) },
  next: [
    summaryItem(commitment),
    {
      key: "plan:1",
      kind: "plan",
      title: "Check the PR",
      status: "pending",
      due: NOW + 2 * MIN,
      next: null,
      priority: null,
      ageMin: 0,
    },
  ],
  done: [summaryItem(incoming), summaryItem(completed)],
});
function stub(extra: Record<string, unknown> = {}) {
  return stubFetch({
    [RESOURCES.config.path]: CREW_CONFIG,
    [RESOURCES.flightSummary.path]: summary,
    [RESOURCES.flightLedgerOpen.path]: flightLedger([...entries, ...watch, commitment]),
    [RESOURCES.flightLedger.path]: flightLedger([...entries, ...watch, commitment, incoming]),
    [RESOURCES.flightSchedule.path]: schedule,
    ...extra,
  });
}

it("renders the whole forward plan as visible operational columns", async () => {
  stub();
  render(<Summary mode="queue" />);
  const plan = await screen.findByRole("list", { name: "FLIGHT forward plan" });
  expect(screen.queryByText(summary.headline)).toBeNull();
  expect(screen.queryByRole("list", { name: "In flight" })).toBeNull();
  const rows = within(plan).getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector(".flight-plan-work b")?.textContent)).toEqual([
    "Watch 1",
    "Watch 2",
    "Watch 3",
    "Watch 4",
    "Watch 5",
    "Watch 6",
    "Send the report",
    "Check the PR",
  ]);
  expect(rows[0]?.querySelector(".flight-plan-owner .ag")?.textContent).toBe("guido-1");
  expect(rows[0]?.querySelector(".flight-plan-health")?.textContent).toBe("Blocked");
  expect(rows[0]?.querySelector(".flight-plan-checkpoint")?.textContent).toContain(
    "Waiting on RETRO",
  );
  expect(screen.getByText("8 tracked · 6 waiting")).toBeTruthy();
  expect(rows[6]?.querySelector(".flight-plan-checkpoint")?.textContent).toContain(
    `Checkpoint ${dayMonth(NOW + MIN, "Europe/London")} ${hhmm(NOW + MIN, "Europe/London")}`,
  );
  expect(screen.queryByRole("list", { name: "Recently done" })).toBeNull();
  expect(screen.queryByLabelText("Last 24 hours")).toBeNull();
});

it("renders commander's intent once and links to the Queue tab", async () => {
  stub();
  const onOpenQueue = vi.fn();
  render(<Summary mode="command" onOpenQueue={onOpenQueue} />);
  expect(await screen.findByText(summary.headline)).toBeTruthy();
  expect(screen.queryByRole("list", { name: "In flight" })).toBeNull();
  expect(screen.getByText(/Explicit FLIGHT synthesis/)).toBeTruthy();
  expect(screen.queryByLabelText("Last 24 hours")).toBeNull();
  expect(document.getElementById("flight-ledger")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open plan" }));
  expect(onOpenQueue).toHaveBeenCalledOnce();
});

it("keeps the primary plan fields and references visible without a disclosure", async () => {
  stub();
  render(<Summary mode="queue" />);
  const list = await screen.findByRole("list", { name: "FLIGHT forward plan" });
  const row = within(list).getAllByRole("listitem")[0] as HTMLElement;
  expect(row.querySelector("details")).toBeNull();
  expect(within(row).getByText("Review the change")).toBeTruthy();
  expect(within(row).getByRole("link", { name: "shop-app #522" }).getAttribute("href")).toBe(
    "https://github.com/octo-org/shop-app/issues/522",
  );
  expect(within(row).getByRole("link", { name: "shop-app PR #523" }).getAttribute("href")).toBe(
    "https://github.com/octo-org/shop-app/pull/523",
  );
  expect(row.querySelector(".flight-plan-age")?.textContent).not.toBe("");
});

it("shows complete commitments and watches without copying active work, arrivals or outcomes", async () => {
  stub();
  render(<Summary mode="queue" />);
  const plan = await screen.findByRole("list", { name: "FLIGHT forward plan" });
  expect(within(plan).getAllByRole("listitem")).toHaveLength(8);
  expect(within(plan).getByText("Watch 6")).toBeTruthy();
  expect(within(plan).queryByText("New request")).toBeNull();
  expect(within(plan).queryByText("Work 3")).toBeNull();
  expect(within(plan).getByText("Check the PR")).toBeTruthy();
  expect(screen.queryByText("All commitments and watches")).toBeNull();
});

it("uses schedule details for plans without confusing them with ledger keys", async () => {
  stub({
    [RESOURCES.flightLedgerOpen.path]: flightLedger([
      ledgerEntry({ key: "plan:1", title: "Unrelated" }),
    ]),
  });
  render(<Summary mode="queue" />);
  const list = await screen.findByRole("list", { name: "FLIGHT forward plan" });
  const row = within(list).getByText("Check the PR").closest("li") as HTMLElement;
  expect(within(row).getByRole("link", { name: "shop-app PR #25" }).getAttribute("href")).toBe(
    "https://github.com/octo-org/shop-app/pull/25",
  );
  expect(row.textContent).toContain("Check CI");
  expect(row.querySelector("time")?.dateTime).toBe(new Date(NOW + 2 * MIN).toISOString());
  expect(row.textContent).not.toContain("Ticket agreed");
});

it("keeps the summary when ledger details fail and reports the error", async () => {
  stub({
    [RESOURCES.flightLedgerOpen.path]: () => ({
      status: 500,
      body: { error: "Details unavailable" },
    }),
  });
  render(<Summary mode="queue" />);
  expect((await screen.findByRole("alert")).textContent).toBe("Ledger: Details unavailable");
  expect(screen.getByRole("list", { name: "FLIGHT forward plan" })).toBeTruthy();
});

it("refreshes summary metrics on run and board changes and ledger details on flight changes", async () => {
  const fetch = stub();
  render(<Summary mode="queue" />);
  await screen.findByRole("list", { name: "FLIGHT forward plan" });
  for (const topic of ["agents", "boards", "flight"] as const) {
    fetch.mockClear();
    act(() => hub.refetchTopic(topic));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([path]) => path === RESOURCES.flightSummary.path)).toBe(true),
    );
    expect(fetch.mock.calls.some(([path]) => path === RESOURCES.flightLedgerOpen.path)).toBe(
      topic === "flight",
    );
  }
});

it("shows the no-seat state", async () => {
  stub({ [RESOURCES.flightSummary.path]: flightSummary({ session: null }) });
  render(<Summary mode="command" />);
  expect(await screen.findByText("No FLIGHT seat is configured.")).toBeTruthy();
});

it("stays usable while new web assets are served by a pre-update server without done", async () => {
  const legacy = { ...flightSummary() } as Partial<ReturnType<typeof flightSummary>>;
  delete legacy.done;
  stub({
    [RESOURCES.flightSummary.path]: legacy,
    [RESOURCES.flightLedger.path]: flightLedger([incoming, completed]),
  });
  render(<Summary mode="record" />);
  expect(await screen.findByText("Shipped work")).toBeTruthy();
  expect(screen.queryByText("New request")).toBeNull();
});

it("keeps outcomes and the 24-hour scorecard together in Record only", async () => {
  stub();
  render(<Summary mode="record" />);
  expect(await screen.findByRole("list", { name: "Recently done" })).toBeTruthy();
  expect(screen.getByText("Shipped work")).toBeTruthy();
  expect(screen.queryByText("New request")).toBeNull();
  const tiles = screen.getByLabelText("Last 24 hours");
  expect([...tiles.querySelectorAll("dt")].map((el) => el.textContent)).toEqual([
    "Merged (24 h)",
    "In review",
    "CI failures",
    "Parks",
    "Spend (24 h)",
  ]);
  expect([...tiles.querySelectorAll("dd")].map((el) => el.textContent)).toEqual([
    "7",
    "4",
    "3",
    "2",
    "~$3.75",
  ]);
  expect(screen.queryByText(summary.headline)).toBeNull();
  expect(screen.queryByRole("list", { name: "FLIGHT forward plan" })).toBeNull();
});

it("shows a loading dash and a summary error", async () => {
  stub({
    [RESOURCES.flightSummary.path]: () => ({ status: 500, body: { error: "Summary unavailable" } }),
  });
  render(<Summary mode="command" />);
  expect(screen.getByText("—")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe("Summary unavailable");
});

it("refreshes the summary when config changes", async () => {
  const fetch = stub();
  render(<Summary mode="command" />);
  await screen.findByText(summary.headline);
  fetch.mockClear();
  act(() => hub.refetchTopic("config"));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([p]) => p === RESOURCES.flightSummary.path)).toBe(true),
  );
});
it("coalesces bursts of agent events for the summary", async () => {
  const fetch = stub();
  render(<Summary mode="command" />);
  await screen.findByText(summary.headline);
  fetch.mockClear();
  act(() => {
    for (let i = 0; i < 10; i++) hub.refetchTopic("agents");
  });
  await waitFor(() =>
    expect(fetch.mock.calls.filter(([p]) => p === RESOURCES.flightSummary.path)).toHaveLength(1),
  );
});

it("does not fetch the historical ledger or render a nested ledger disclosure in Plan", async () => {
  const fetch = stub();
  render(<Summary mode="queue" />);
  await screen.findByRole("list", { name: "FLIGHT forward plan" });
  expect(fetch.mock.calls.some(([p]) => p === RESOURCES.flightLedger.path)).toBe(false);
  expect(screen.queryByText("All commitments and watches")).toBeNull();
});
