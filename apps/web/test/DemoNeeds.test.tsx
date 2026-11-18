import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { setDemo } from "../src/demo/mode.ts";
import { getState, playNext } from "../src/demo/simulator.ts";
import { demoMisses } from "../src/demo/source.ts";
import { DEMO_ARRIVING_KEY, DEMO_DESIGN_KEY, DEMO_PLAIN_KEY } from "./demoNeeds.ts";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  setDemo(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 400))));

async function open(key: string) {
  window.history.replaceState(null, "", `/needs-you/${key}`);
  render(<App />);
  await settle();
}

it("shows the design sign-off with its before/after pictures", async () => {
  await open(DEMO_DESIGN_KEY);
  const mat = await screen.findByRole("region", { name: "Plan and mockups" });
  const compare = await waitFor(() => {
    const el = mat.querySelector<HTMLElement>("[data-comparison='before-after']");
    if (!el) throw new Error("no comparison yet");
    return el;
  });
  expect(within(compare).getByText("Before")).toBeTruthy();
  expect(within(compare).getByText("Proposed")).toBeTruthy();
  await within(compare).findByRole("button", { name: "Open Before full size" });
  expect(demoMisses()).toEqual([]);
});

it("shows the ticket's plan beside the question", async () => {
  await open(DEMO_DESIGN_KEY);
  const plan = await screen.findByRole("region", { name: "Plan of shop-app#104" });
  expect(within(plan).getByText("Detail")).toBeTruthy();
  expect(within(plan).getByText("Cover both layouts in the component tests.")).toBeTruthy();
});

it("the scene brings a question and answers another", () => {
  const keys = () => (getState().api["/api/attention"] as { key: string }[]).map((q) => q.key);
  expect(keys()).toContain(DEMO_PLAIN_KEY);
  expect(keys()).not.toContain(DEMO_ARRIVING_KEY);
  for (let i = 0; i < 45; i++) playNext();
  expect(keys()).toContain(DEMO_ARRIVING_KEY);
  expect(keys()).not.toContain(DEMO_PLAIN_KEY);
  expect((getState().api["/api/attention/answered"] as unknown[]).length).toBeGreaterThan(1);
});
