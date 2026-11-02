import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { costRate } from "../src/fmt.ts";
import { MeasuredHistory } from "../src/overview/OverviewHistoryPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  hub.clear();
});
const source = () =>
  stubFetch({ "/api/config": { ...CONFIG, operator: { id: "operator", timezone: "UTC" } } });
it("keeps missing minutes as gaps and distinguishes unknown history from observed zero", async () => {
  source();
  const view = render(
    <MeasuredHistory
      values={[10, null, 20]}
      format={String}
      label="Measured rate"
      unit="tokens/min"
      at={NOW}
    />,
  );
  await waitFor(() => expect(screen.getAllByText("11:57")[0]).toBeTruthy());
  const graph = screen.getByRole("img", { name: /Measured rate/ });
  expect(graph.querySelector("path")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  expect(view.container.textContent).toContain("Latest 20 tokens/min");
  expect(view.container.textContent).toContain("Peak 20");
  view.rerender(
    <MeasuredHistory
      values={[null, null]}
      format={String}
      label="Measured rate"
      unit="tokens/min"
      at={NOW}
    />,
  );
  expect(screen.getByText("History not collected for this window.")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  view.rerender(
    <MeasuredHistory
      values={[0, 0]}
      format={String}
      label="Measured rate"
      unit="tokens/min"
      at={NOW}
    />,
  );
  expect(screen.getByText("No activity in the measured minutes.")).toBeTruthy();
  expect(screen.getByRole("img")).toBeTruthy();
});
it("uses the displayed fractional dollar scale instead of flattening spend below one dollar", () => {
  source();
  const v = render(
    <MeasuredHistory
      values={[0.1, 0.2]}
      format={(n) => `$${n.toFixed(2)}`}
      label="Cost per minute"
      unit="USD/min"
      at={NOW}
    />,
  );
  expect(v.container.querySelector(".measured-y")?.textContent).toBe("$0.20$0.10$0.00");
  expect(v.container.querySelector("path")?.getAttribute("d")).toMatch(/L100\.0,3\.0$/);
  expect(v.container.textContent).toContain("Latest $0.20 USD/min");
});

it("retains a nonzero sub-cent USD/minute rate in latest, peak and axis labels", () => {
  source();
  const v = render(
    <MeasuredHistory
      values={[0.001, 0.002]}
      format={costRate}
      label="Cost per minute"
      unit="USD/min"
      at={NOW}
    />,
  );
  expect(v.container.textContent).toContain("Latest ~$0.002 USD/min");
  expect(v.container.textContent).toContain("Peak ~$0.002");
  expect(v.container.querySelector(".measured-y")?.textContent).toContain("~$0.001");
  expect(v.container.textContent).not.toContain("$0.00 USD/min");
});
