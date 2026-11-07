import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TokenAudit } from "../src/code-health/TokenAudit.tsx";
import { hub, RESOURCES } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { tokenAuditFixture } from "./tokenAuditFixture.ts";

const PATH = (days: number) => RESOURCES.tokenAudit(days).path;

beforeEach(() => hub.clear());
afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});

it("shows each figure with its window and unit", async () => {
  stubFetch({ [PATH(7)]: tokenAuditFixture() });
  render(<TokenAudit />);
  const strip = await screen.findByRole("list", { name: "Token figures" });
  const text = strip.textContent ?? "";
  expect(text).toContain("412 runs");
  expect(text).toContain("31,850 model calls");
  expect(text).toContain("2.71B tokens");
  expect(text).toContain("64 cache rewrites");
  expect(text).toContain("62%");
  expect(text).toMatch(/last 7 days/);
  expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
});

it("links every heaviest run to its trace and never a bare id", async () => {
  stubFetch({ [PATH(7)]: tokenAuditFixture() });
  render(<TokenAudit />);
  const panel = (await screen.findByRole("region", { name: "Heaviest runs" })) as HTMLElement;
  const links = within(panel).getAllByRole("link");
  expect(links.map((a) => a.getAttribute("href"))).toEqual([
    "/agent/inco-1?trace=run-4821",
    "/agent/flight-1?trace=run-4790",
  ]);
});

it("names the gap on the unlinked tables and lists the figures not recorded yet", async () => {
  stubFetch({ [PATH(7)]: tokenAuditFixture() });
  render(<TokenAudit />);
  const gap = (await screen.findByRole("region", { name: "Not recorded yet" })) as HTMLElement;
  for (const word of [
    "90th percentile",
    "budget",
    "1,000 characters",
    "sent again unchanged",
    "wait before each cache rewrite",
    "Review runs a ticket",
    "FLIGHT wakes",
    "Cost per merged PR",
  ])
    expect(gap.textContent).toContain(word);
  const sources = screen.getByRole("region", { name: "Biggest sources of re-reading" });
  expect(within(sources).queryAllByRole("link")).toEqual([]);
  expect(sources.textContent).toContain("do not name the run");
});

it("reads another window when asked", async () => {
  const fetch = stubFetch({
    [PATH(7)]: tokenAuditFixture(),
    [PATH(30)]: tokenAuditFixture({ days: 30 }),
  });
  render(<TokenAudit />);
  await screen.findByRole("list", { name: "Token figures" });
  fireEvent.click(screen.getByRole("button", { name: "30 days" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(PATH(30), expect.anything()));
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Token figures" }).textContent).toContain(
      "last 30 days",
    ),
  );
});

it("says what it is doing while loading", () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  render(<TokenAudit />);
  expect(screen.getByRole("status").textContent).toBe(
    "Reading the token audit for the last 7 days…",
  );
});

it("says why it failed and offers a retry", async () => {
  stubFetch({});
  render(<TokenAudit />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The token audit could not be read");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("says there is nothing to audit when no run started in the window", async () => {
  stubFetch({
    [PATH(7)]: tokenAuditFixture({
      runs: 0,
      calls: 0,
      byRole: [],
      bySource: [],
      byCommand: [],
      topRuns: [],
      hubSections: [],
      readAfterReportShare: null,
    }),
  });
  render(<TokenAudit />);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "No runs started in the last 7 days, so there is nothing to audit yet.",
    ),
  );
  expect(document.body.textContent).not.toMatch(/no data/i);
});

it("says when the hub is not recording controller sessions, and shows them when it is", async () => {
  stubFetch({ [PATH(7)]: tokenAuditFixture() });
  const first = render(<TokenAudit />);
  expect((await screen.findByRole("list", { name: "Token figures" })).textContent).toContain(
    "Not recorded: switched off",
  );
  first.unmount();
  hub.clear();
  stubFetch({
    [PATH(7)]: tokenAuditFixture({
      controller: {
        sessions: 7,
        calls: 4692,
        input: 1,
        cacheRead: 1_467_000_000,
        cacheWrite: 1,
        output: 1,
      },
    }),
  });
  render(<TokenAudit />);
  expect((await screen.findByRole("list", { name: "Token figures" })).textContent).toContain(
    "7 controller sessions",
  );
});
