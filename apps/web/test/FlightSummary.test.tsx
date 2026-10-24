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
});
function stub(extra: Record<string, unknown> = {}) {
  return stubFetch({
    [RESOURCES.config.path]: CREW_CONFIG,
    [RESOURCES.flightSummary.path]: summary,
    [RESOURCES.flightLedger.path]: flightLedger([...entries, ...watch, commitment, incoming]),
    [RESOURCES.flightSchedule.path]: schedule,
    ...extra,
  });
}

it("renders the headline, capped lists in served order, status counts, due times and tiles", async () => {
  stub();
  render(<Summary />);
  expect(await screen.findByText(summary.headline)).toBeTruthy();
  const now = screen.getByRole("list", { name: "Now" });
  const rows = within(now).getAllByRole("listitem");
  expect(
    rows.map((row) => row.querySelector("summary > span > span:not(.pill)")?.textContent),
  ).toEqual(["Work 6", "Work 2", "Work 4", "Work 1", "Work 5"]);
  expect(rows[0]?.querySelector("summary")?.textContent).toContain("guido-1");
  expect(rows[0]?.querySelector("summary")?.textContent).toContain("active");
  expect(rows[0]?.querySelector("summary")?.textContent).toContain("waiting on RETRO");
  expect(
    within(screen.getByRole("list", { name: "Watching" })).getAllByRole("listitem"),
  ).toHaveLength(5);
  expect(screen.getByText("3 active · 1 blocked · 2 waiting")).toBeTruthy();
  const next = screen.getByRole("list", { name: "Next" });
  expect(next.tagName).toBe("OL");
  expect(
    within(next)
      .getAllByRole("listitem")
      .map((row) => row.querySelector("summary")?.textContent),
  ).toEqual([
    `guido-1Send the reportactivewaiting on RETRODue ${dayMonth(NOW + MIN, "Europe/London")} ${hhmm(NOW + MIN, "Europe/London")}`,
    `Check the PRpendingDue ${dayMonth(NOW + 2 * MIN, "Europe/London")} ${hhmm(NOW + 2 * MIN, "Europe/London")}`,
  ]);
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
});

it("opens a whole summary line in place to reveal next, linked refs and its update time", async () => {
  stub();
  render(<Summary />);
  const list = await screen.findByRole("list", { name: "Now" });
  const row = within(list).getAllByRole("listitem")[0] as HTMLElement;
  const details = row.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  fireEvent.click(within(row).getByText("Work 6"));
  expect(details.open).toBe(true);
  expect(within(row).getByText("Review the change")).toBeTruthy();
  expect(within(row).getByRole("link", { name: "shop-app #522" }).getAttribute("href")).toBe(
    "https://github.com/octo-org/shop-app/issues/522",
  );
  expect(within(row).getByRole("link", { name: "shop-app PR #523" }).getAttribute("href")).toBe(
    "https://github.com/octo-org/shop-app/pull/523",
  );
  expect(row.querySelector("time")?.dateTime).toBe(new Date(NOW - MIN).toISOString());
  fireEvent.click(within(row).getByText("Work 6"));
  expect(details.open).toBe(false);
});

it("opens full lists grouped by kind, including entries beyond the summary and closed work", async () => {
  stub();
  render(<Summary />);
  fireEvent.click(await screen.findByRole("link", { name: "Ledger" }));
  const ledger = document.getElementById("flight-ledger") as HTMLDetailsElement;
  expect(ledger.open).toBe(true);
  expect(
    within(ledger)
      .getAllByRole("heading")
      .map((el) => el.textContent),
  ).toEqual(["Work", "Watch", "Commitments", "Incoming", "Scheduled"]);
  expect(
    within(within(ledger).getByRole("region", { name: "Work" })).getAllByRole("listitem"),
  ).toHaveLength(6);
  expect(within(ledger).getByText("Work 3")).toBeTruthy();
  expect(within(ledger).getByText("New request")).toBeTruthy();
  expect(within(ledger).getByText("Check the PR")).toBeTruthy();
});

it("uses schedule details for plans without confusing them with ledger keys", async () => {
  stub({
    [RESOURCES.flightLedger.path]: flightLedger([
      ledgerEntry({ key: "plan:1", title: "Unrelated" }),
    ]),
  });
  render(<Summary />);
  const list = await screen.findByRole("list", { name: "Next" });
  const row = within(list).getAllByRole("listitem")[1] as HTMLElement;
  fireEvent.click(within(row).getByText("Check the PR"));
  expect(within(row).getByRole("link", { name: "shop-app PR #25" }).getAttribute("href")).toBe(
    "https://github.com/octo-org/shop-app/pull/25",
  );
  // A plan's detail is its recorded outcome, not its next step.
  expect(row.textContent).not.toContain("Check CI");
  expect(row.querySelector("time")?.dateTime).toBe(new Date(NOW + 2 * MIN).toISOString());
  expect(row.textContent).not.toContain("Ticket agreed");
});

it("keeps the summary when ledger details fail and reports the error", async () => {
  stub({
    [RESOURCES.flightLedger.path]: () => ({ status: 500, body: { error: "Details unavailable" } }),
  });
  render(<Summary />);
  expect(await screen.findByText(summary.headline)).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe("Ledger: Details unavailable");
  expect(screen.getByRole("list", { name: "Now" })).toBeTruthy();
});

it("refreshes summary metrics on run and board changes and ledger details on flight changes", async () => {
  const fetch = stub();
  render(<Summary />);
  await screen.findByText(summary.headline);
  for (const topic of ["agents", "boards", "flight"] as const) {
    fetch.mockClear();
    act(() => hub.refetchTopic(topic));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([path]) => path === RESOURCES.flightSummary.path)).toBe(true),
    );
    expect(fetch.mock.calls.some(([path]) => path === RESOURCES.flightLedger.path)).toBe(
      topic === "flight",
    );
  }
});
