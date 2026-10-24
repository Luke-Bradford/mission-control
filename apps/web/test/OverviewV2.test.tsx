import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { MachinePanel } from "../src/overview/MachinePanel.tsx";
import { QuotaMeter } from "../src/overview/QuotaMeter.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, limit7d, NOW } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("filters each live log chip and remembers the selection", async () => {
  const kinds = ["run-start", "pr-opened", "pr-merged", "loop", "guard"];
  stubFetch({
    "/api/activity": kinds.map((kind, i) => ({
      at: NOW - i,
      who: "seat",
      kind,
      text: kind === "loop" ? "merge: started" : kind,
      ref: null,
      url: null,
      prs: [],
      status: null,
      summary: null,
    })),
    "/api/crew": { rows: [] },
    "/api/config": CONFIG,
    "/api/attention": [
      { key: "a", at: NOW, text: "Operator call", owner: "operator", agentId: null, repoId: null },
    ],
  });
  const view = render(<ActivityPanel />);
  await screen.findByText("run-start");
  for (const [chip, count] of [
    ["All", 6],
    ["Steps", 5],
    ["Reviews", 2],
    ["Merges", 2],
    ["Guard", 1],
    ["Needs you", 1],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: chip }));
    expect(screen.getByRole("button", { name: chip }).getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelectorAll(".arow")).toHaveLength(count);
  }
  view.unmount();
  render(<ActivityPanel />);
  expect(screen.getByRole("button", { name: "Needs you" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});
it("shows machine history as CPU and memory graphs", async () => {
  stubFetch({
    "/api/machine": { latest: null },
    "/api/overview": { machine: { cpu: [10, 30], mem: [40, 50], diskFreeGb: 80 } },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  render(<MachinePanel />);
  expect(await screen.findByRole("img", { name: "CPU history" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Memory history" })).toBeTruthy();
});
it("marks the projected quota at reset", async () => {
  stubFetch({ "/api/health": [] });
  const { container } = render(<QuotaMeter row={limit7d({ projected: 84 })} now={NOW} />);
  await waitFor(() =>
    expect(container.querySelector<HTMLElement>(".projection-tick")?.style.left).toBe("84%"),
  );
});
