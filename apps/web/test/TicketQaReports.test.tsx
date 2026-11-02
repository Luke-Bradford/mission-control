import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TicketQaReports } from "../src/qa/TicketQaReports.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";
import { qaReportFixture, ticketQaReportFixture } from "./qaReportFixture.ts";

afterEach(() => vi.unstubAllGlobals());
const url = "https://github.com/octo-org/shop-app/pull/40";
const path = "/api/qa-reports?repoId=shop-app&prNumber=40";
const report = ticketQaReportFixture;

it("links an immutable saved report and states earlier-commit evidence and visual coverage", async () => {
  const r = report();
  stubFetch({ "/api/config": CONFIG, [path]: { reports: [r] } });
  render(<TicketQaReports prs={[{ number: 40, url, headSha: "d".repeat(40) }]} />);
  expect(
    (await screen.findByRole("link", { name: "Open QA report · aaaaaaaa" })).getAttribute("href"),
  ).toBe(r.permalink);
  expect(screen.getByText(/Earlier PR commit/)).toBeTruthy();
  expect(screen.getByText(/1 before\/after pair/)).toBeTruthy();
});

it("distinguishes missing evidence from a backend report with screenshots explicitly inapplicable", async () => {
  const r = report();
  r.visual = { applicability: "not_applicable", reason: "Backend-only change.", pairs: [] };
  stubFetch({
    "/api/config": CONFIG,
    [path]: { reports: [r] },
    "/api/qa-reports?repoId=shop-app&prNumber=41": { reports: [] },
  });
  render(
    <TicketQaReports
      prs={[
        { number: 40, url },
        { number: 41, url: url.replace("40", "41") },
      ]}
    />,
  );
  await screen.findByText(/Screenshots not applicable/);
  expect(await screen.findByText(/No saved QA report/)).toBeTruthy();
});

it("resolves a configured cross-repo PR from its own URL and never queries an unconfigured repository", async () => {
  const fn = stubFetch({
    "/api/config": {
      ...CONFIG,
      repos: [...CONFIG.repos, { id: "other", github: "octo-org/other" }],
    },
    "/api/qa-reports?repoId=other&prNumber=40": { reports: [] },
  });
  render(
    <TicketQaReports
      prs={[
        { number: 40, url: "https://github.com/octo-org/other/pull/40" },
        { number: 40, url: "https://github.com/stranger/other/pull/40" },
      ]}
    />,
  );
  await screen.findByText(/other PR #40/);
  expect(screen.getByText(/repository is not configured/)).toBeTruthy();
  await waitFor(() =>
    expect(fn.mock.calls.some(([p]) => p === "/api/qa-reports?repoId=other&prNumber=40")).toBe(
      true,
    ),
  );
  expect(fn.mock.calls.some(([p]) => p === path)).toBe(false);
});

it("shows a report loading failure without calling it absent", async () => {
  stubFetch({ "/api/config": CONFIG });
  render(<TicketQaReports prs={[{ number: 40, url }]} />);
  expect(await screen.findByText(/Saved QA reports could not be loaded/)).toBeTruthy();
  expect(screen.queryByText(/No saved QA report/)).toBeNull();
});

it("does not display another repository or PR's evidence as this ticket's QA", async () => {
  stubFetch({
    "/api/config": CONFIG,
    [path]: {
      reports: [
        qaReportFixture(),
        { ...report(), prNumber: 41 },
        { ...report(), github: "stranger/shop-app" },
      ],
    },
  });
  render(<TicketQaReports prs={[{ number: 40, url }]} />);
  await screen.findByText(/No saved QA report/);
  expect(screen.queryByRole("link", { name: /Open QA report/ })).toBeNull();
});
