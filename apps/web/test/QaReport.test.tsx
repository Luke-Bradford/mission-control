import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/api.ts";
import { QaReportRead, qaEvidenceUrl } from "../src/qa/QaReport.tsx";
import { qaReportFixture } from "./qaReportFixture.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function retainedImage() {
  let serial = 0;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL() {
        return `blob:qa-focus-${++serial}`;
      }
      static override revokeObjectURL() {}
    },
  );
  const blob = new Blob(["controlled image bytes"], { type: "image/png" });
  const read = vi.spyOn(api, "apiQaReportImage").mockResolvedValue(blob);
  const report = qaReportFixture();
  report.visual.pairs[0].before.url = `/api/qa-report-assets/${"f".repeat(64)}`;
  return { report, blob, read };
}
it("keeps keyboard focus on an image source and its retried preview", () => {
  render(<QaReportRead report={qaReportFixture()} />);
  const before = screen.getByRole("img", { name: /Before · Overview/ });
  const preview = before.closest("a");
  preview?.focus();
  expect(document.activeElement).toBe(preview);
  fireEvent.error(before);
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open image source" }));
  const retry = screen.getByRole("button", { name: /Retry linked image · Before/ });
  retry.focus();
  fireEvent.click(retry);
  expect(document.activeElement).toBe(
    screen.getByRole("img", { name: /Before · Overview/ }).closest("a"),
  );
});
it("does not move another control's focus when an unrelated image fails", () => {
  render(<QaReportRead report={qaReportFixture()} />);
  const reference = screen.getByRole("link", { name: "Ticket reference" });
  reference.focus();
  fireEvent.error(screen.getByRole("img", { name: /Before · Overview/ }));
  expect(document.activeElement).toBe(reference);
});
it("keeps a retained image error and its asynchronous retry keyboard reachable", async () => {
  const { report } = retainedImage();
  render(<QaReportRead report={report} />);
  const preview = await screen.findByRole("img", { name: /Before · Overview/ });
  preview.closest("a")?.focus();
  fireEvent.error(preview);
  const retry = screen.getByRole("button", { name: /^Retry image · Before/ });
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  const loaded = await screen.findByRole("img", { name: /Before · Overview/ });
  expect(document.activeElement).toBe(loaded.closest("a"));
});
it("does not steal focus after the operator moves on during a retained retry", async () => {
  const { report, blob, read } = retainedImage();
  render(<QaReportRead report={report} />);
  const preview = await screen.findByRole("img", { name: /Before · Overview/ });
  preview.closest("a")?.focus();
  fireEvent.error(preview);
  let finish: ((value: Blob) => void) | undefined;
  read.mockImplementationOnce(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Retry image · Before/ }));
  const reference = screen.getByRole("link", { name: "Ticket reference" });
  reference.focus();
  if (!finish) throw new Error("Retry did not start");
  finish(blob);
  await screen.findByRole("img", { name: /Before · Overview/ });
  expect(document.activeElement).toBe(reference);
});
it("makes a failed linked image explicit and preserves its source and retry", () => {
  render(<QaReportRead report={qaReportFixture()} />);
  const before = screen.getByRole("img", { name: /Before · Overview/ });
  fireEvent.error(before);
  expect(screen.getByText("The linked image could not be loaded.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open image source" }).getAttribute("href")).toBe(
    "https://evidence.example/before.png",
  );
  fireEvent.click(screen.getByRole("button", { name: /Retry linked image · Before/ }));
  expect(screen.getByRole("img", { name: /Before · Overview/ })).toBeTruthy();
});
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
