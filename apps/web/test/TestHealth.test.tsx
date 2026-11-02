import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TestHealth } from "../src/code-health/TestHealth.tsx";
import { testHealthFixture } from "./testHealthFixtures.ts";

afterEach(cleanup);
function setup(count = 4) {
  const fixture = testHealthFixture(undefined, count),
    onInspect = vi.fn();
  return {
    ...fixture,
    onInspect,
    render: () => render(<TestHealth {...fixture} onInspect={onInspect} />),
  };
}
it("separates job candidates, executed denominators and four classifications", () => {
  const h = setup();
  h.render();
  expect(
    within(screen.getByRole("region", { name: "Job observations" })).getByText("3"),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Executed named-test attempts" })).getByText(
      "10 failed / 17 executed attempts",
    ),
  ).toBeTruthy();
  for (const name of ["Candidate", "Confirmed flaky", "Consistently failing", "Infrastructure"])
    expect(screen.getByText(name)).toBeTruthy();
  expect(screen.getByText(/Skipped, cancelled and not-run/)).toBeTruthy();
  expect(screen.getByText(/Retry order uncertain/)).toBeTruthy();
  expect(screen.getByText(/Mixed results remain candidates/)).toBeTruthy();
});
it("keeps partial percentages unknown while retaining observed counts", () => {
  const h = setup();
  h.data.namedTestRate = { numerator: 10, denominator: 17, percent: null };
  h.data.disruption[0].rate = { numerator: 4, denominator: 5, percent: null };
  h.coverage[1].complete = false;
  h.render();
  expect(screen.getAllByText("Rate unknown")).toHaveLength(2);
  expect(screen.getByText("10 failed / 17 executed attempts")).toBeTruthy();
  expect(screen.queryByText("58.8% failed")).toBeNull();
});
it("opens exact group, documented-unit samples and original QA provenance", () => {
  const h = setup();
  h.render();
  fireEvent.click(screen.getByRole("button", { name: h.data.disruption[0].label }));
  expect(h.onInspect).toHaveBeenLastCalledWith(
    `Test attempts: ${h.data.disruption[0].label}`,
    [h.refs.ordered],
    [h.coverage[1]],
  );
  expect(screen.getByText(/p50 \/ p95 · milliseconds/)).toBeTruthy();
  expect(screen.getAllByText("macOS · Node 25", { exact: false })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "account 0 › saves a draft" }));
  expect(h.onInspect).toHaveBeenLastCalledWith(
    "Duration samples: account 0 › saves a draft",
    [h.refs.samples],
    [h.coverage[2]],
  );
  fireEvent.click(screen.getByRole("button", { name: "test-0" }));
  expect(h.onInspect).toHaveBeenLastCalledWith(
    "QA code/spec evidence: test-0",
    [h.refs.qa],
    [h.coverage[3]],
  );
  expect(screen.getByText(/reviewer reviewer-0/)).toBeTruthy();
  expect(screen.getAllByText(/by operator-fixture/)).toHaveLength(4);
});
it("names missing collection without zero failures, invented durations or age verdicts", () => {
  const h = setup(0);
  h.render();
  expect(screen.getAllByText("Not collected")).toHaveLength(2);
  expect(screen.getByText(/No classified disruption groups/)).toBeTruthy();
  expect(screen.getByText(/Comparable durations are not collected/)).toBeTruthy();
  expect(screen.getByText(/Test age alone does not prove/)).toBeTruthy();
  expect(screen.queryByText("0% failed")).toBeNull();
});
it("retains long identities, 50 inspectable rows and explicit omitted counts", () => {
  const h = setup(50),
    long = `tests/${"long-module/".repeat(25)}account.test.ts › preserves state`;
  h.data.disruption[0].label = long;
  h.data.omitted = { disruption: 12, durations: 3, qaProposals: 5 };
  h.render();
  expect(screen.getByRole("button", { name: long }).getAttribute("title")).toBe(long);
  const table = screen.getByRole("region", { name: "Ranked test disruption" });
  expect(table.getAttribute("tabindex")).toBe("0");
  expect(within(table).getAllByRole("row")).toHaveLength(51);
  expect(screen.getByText(/12 more disruption groups/)).toBeTruthy();
  expect(screen.getByText(/3 more duration groups/)).toBeTruthy();
  expect(screen.getByText(/5 more QA proposals/)).toBeTruthy();
});
