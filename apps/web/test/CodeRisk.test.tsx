import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeRisk } from "../src/code-health/CodeRisk.tsx";
import { codeRiskFixture } from "./codeRiskFixtures.ts";

afterEach(cleanup);
function setup(count = 6) {
  const fixture = codeRiskFixture(Date.UTC(2026, 10, 2, 12), count),
    onInspect = vi.fn();
  const renderRisk = () =>
    render(
      <CodeRisk
        data={fixture.data}
        coverage={fixture.coverage}
        window="30d"
        repo="sample"
        onInspect={onInspect}
      />,
    );
  return { ...fixture, onInspect, renderRisk };
}
it("keeps independent measured inputs, missing values and exact file evidence", () => {
  const h = setup();
  h.renderRisk();
  const table = screen.getByRole("region", { name: "File risk measurements" });
  const unknown = within(table).getByRole("row", { name: /src\/domain\/worker-1.ts/ });
  expect(within(unknown).getAllByText("—")).toHaveLength(3);
  fireEvent.click(within(table).getByRole("button", { name: "src/domain/state.ts" }));
  expect(h.onInspect).toHaveBeenCalledWith("src/domain/state.ts", [h.ref], h.coverage);
  expect(screen.getByRole("link", { name: "Open repo in Map" }).getAttribute("href")).toBe(
    "/map/sample",
  );
  expect(screen.getByRole("link", { name: "Open repo in Map" }).getAttribute("target")).toBe(
    "_blank",
  );
});
it("sorts unknown values last in both directions and includes test files only on request", () => {
  const h = setup();
  h.renderRisk();
  const table = screen.getByRole("region", { name: "File risk measurements" });
  expect(within(table).queryByText("src/state.test.ts")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Include test files" }));
  expect(within(table).getByText("src/state.test.ts")).toBeTruthy();
  fireEvent.click(within(table).getByRole("button", { name: "Lines ↓" }));
  expect(
    within(table).getByRole("columnheader", { name: "Lines ↑" }).getAttribute("aria-sort"),
  ).toBe("ascending");
  expect(within(table).getAllByRole("row").at(-1)?.textContent).toContain("worker-1.ts");
  fireEvent.click(within(table).getByRole("button", { name: "Lines ↑" }));
  expect(within(table).getAllByRole("row").at(-1)?.textContent).toContain("worker-1.ts");
});
it("draws only measured points on common scales and never joins incomparable snapshots", () => {
  const h = setup();
  h.renderRisk();
  const charts = screen.getAllByRole("img");
  expect(charts).toHaveLength(4);
  expect(charts.filter((chart) => chart.querySelector("polyline"))).toHaveLength(3);
  expect(charts.every((chart) => chart.querySelectorAll("circle").length === 2)).toBe(true);
  expect(screen.getByText("Scope or current point differs · no trend")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: /13 Oct · aaaaaaaa/ })[0]);
  expect(h.onInspect).toHaveBeenLastCalledWith(`Snapshot ${"a".repeat(40)}`, [h.ref], h.coverage);
});
it("retains one observation without claiming growth or pre-rename history", () => {
  const h = setup(1);
  h.data.sizeHistory[0].points.splice(1);
  h.data.sizeHistory[0].comparable = false;
  h.renderRisk();
  // The single fixture path is a test file, initially excluded.
  fireEvent.click(screen.getByRole("checkbox", { name: "Include test files" }));
  expect(screen.getByText("One observation · growth unknown")).toBeTruthy();
  expect(screen.getByRole("img").querySelector("polyline")).toBeNull();
});
it("keeps 50 long paths inspectable in a keyboard-scrollable measured table", () => {
  const h = setup(50);
  const long = `src/${"long-path/".repeat(30)}file.ts`;
  h.data.files[0].path = long;
  h.renderRisk();
  const region = screen.getByRole("region", { name: "File risk measurements" });
  expect(region.getAttribute("tabindex")).toBe("0");
  expect(within(region).getAllByRole("row")).toHaveLength(50);
  expect(within(region).getByRole("button", { name: long }).getAttribute("title")).toBe(long);
});
it("names missing collection instead of treating an empty cohort as healthy", () => {
  const h = setup(0);
  h.renderRisk();
  expect(screen.getByText(/No scoped files are available/)).toBeTruthy();
  expect(screen.getByText(/Size history is not collected/)).toBeTruthy();
  expect(screen.getByText(/No qualifying pairs are available/)).toBeTruthy();
});
