import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QaReportRead, qaEvidenceUrl } from "../src/qa/QaReport.tsx";
import { qaReportFixture } from "./qaReportFixture.ts";

afterEach(cleanup);
it("retains a permanent exact-head record and distinguishes receipts from reported counts", () => {
  const report = qaReportFixture();
  render(<QaReportRead report={report} archived />);
  expect(screen.getByText(report.headSha)).toBeTruthy();
  expect(screen.getByText(/Saved historical report/)).toBeTruthy();
  expect(screen.getByText("hub receipt")).toBeTruthy();
  expect(screen.getByText("reviewer reported")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Permanent QA report" }).getAttribute("href")).toBe(
    report.permalink,
  );
  expect(screen.getByRole("link", { name: "Markdown reference" }).getAttribute("href")).toBe(
    `/api/qa-reports/${report.id}/markdown`,
  );
  expect(screen.getAllByRole("img")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Ticket reference" }).getAttribute("href")).toContain(
    "/issues/656",
  );
});
it("shows missing evidence and all unrecorded checklist items instead of a clean sign-off", () => {
  const report = qaReportFixture();
  report.completeness = { state: "incomplete", missing: ["Visual pairs missing"] };
  report.coverage = [];
  report.tests = [];
  report.visual = { applicability: "unknown", pairs: [] };
  render(<QaReportRead report={report} />);
  expect(screen.getByText("Evidence incomplete")).toBeTruthy();
  expect(screen.getAllByText("Not recorded")).toHaveLength(11);
  expect(screen.getByText(/Before\/after pairs are missing/)).toBeTruthy();
  expect(screen.queryByText("QA passed · recorded scope")).toBeNull();
  expect(screen.getByText(/No test execution evidence was recorded/)).toBeTruthy();
});
it("requires an explicit non-visual reason while keeping the rest of the report", () => {
  const report = qaReportFixture();
  report.visual = {
    applicability: "not_applicable",
    reason: "Only server-side validation changes; no rendered interface changes.",
    pairs: [],
  };
  render(<QaReportRead report={report} />);
  expect(screen.getByText(report.visual.reason ?? "")).toBeTruthy();
  expect(screen.getByText("Not applicable · reason required")).toBeTruthy();
  expect(screen.queryByText(/Before\/after pairs are missing/)).toBeNull();
});
it("marks another head stale even when its historical review passed", () => {
  render(<QaReportRead report={qaReportFixture()} currentHead={"d".repeat(40)} />);
  expect(screen.getByText("Different head · not current sign-off")).toBeTruthy();
  expect(screen.queryByText("QA passed · recorded scope")).toBeNull();
});
it("does not present a passed review as green CI when its recorded CI failed", () => {
  const report = qaReportFixture();
  report.ci.checks[0].state = "failing";
  report.ci.checks[0].conclusion = "FAILURE";
  render(<QaReportRead report={report} />);
  expect(screen.getByText("CI failed · review passed")).toBeTruthy();
  expect(screen.queryByText("QA passed · recorded scope")).toBeNull();
});
it("keeps failed review findings actionable and retains prior resolutions", () => {
  const report = qaReportFixture();
  report.verdict.quality = "fail";
  report.findings = [
    {
      severity: "Important",
      file: "src/Controls.tsx",
      line: 3,
      summary: "Control clips.",
      scenario: "At 1280 pixels, the action lies outside the row.",
      fix: "Bound the action column.",
    },
  ];
  report.resolutions = [{ findingRef: { reviewId: 42, pos: 1 }, outcome: "fixed" }];
  render(<QaReportRead report={report} />);
  expect(screen.getByText("Rework required")).toBeTruthy();
  expect(screen.getByText("Control clips.")).toBeTruthy();
  expect(screen.getByText("Review 42, finding 1: fixed")).toBeTruthy();
});
it("does not create executable links or remote images from unsafe evidence URLs", () => {
  const report = qaReportFixture();
  report.visual.pairs[0].before.url = "javascript:alert(1)";
  report.prUrl = "javascript:alert(2)";
  render(<QaReportRead report={report} />);
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "GitHub PR" })).toBeNull();
  for (const url of [
    "//evil.test/a",
    "data:image/svg+xml,x",
    "file:///tmp/x",
    "https://u:p@evil.test/a",
  ])
    expect(qaEvidenceUrl(url)).toBeNull();
});
it("retains fifty long test commands and unknown counts without inventing totals", () => {
  const report = qaReportFixture();
  report.tests = Array.from({ length: 50 }, (_, i) => ({
    command: `test ${i} ${"long-name/".repeat(30)}`,
    origin: "reviewer-reported",
    outcome: "unknown",
  }));
  render(<QaReportRead report={report} />);
  const section = screen.getByText("Tests and command evidence").closest("section");
  expect(section).toBeTruthy();
  if (section) expect(within(section).getAllByText(/Reported counts: — passed/)).toHaveLength(50);
});
