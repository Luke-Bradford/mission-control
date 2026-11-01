import type { CrewRow, FlightView, PromptWakeCost, RunLoopView } from "@mc/core";
import { PROMPT_SECTIONS } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptTab } from "../src/agent/PromptTab.tsx";
import { hub, RESOURCES } from "../src/data.ts";
import { PromptWakes } from "../src/flight/PromptWakes.tsx";
import { hhmm } from "../src/fmt.ts";
import { NO_SECTION_DATA, PROMPT_SECTION_LABEL, PromptCostBar } from "../src/hud/PromptCost.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG, crewRow, NOW } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

const TOKENS = [1200, 800, 400, 300, 2000, 500, 3000];
const wake = (n: number, tokens: readonly number[] = TOKENS): PromptWakeCost => ({
  runId: "run-1",
  wake: n,
  at: NOW - n * 60_000,
  sections: PROMPT_SECTIONS.map((section, i) => ({
    section,
    bytes: (tokens[i] ?? 0) * 4,
    tokens: tokens[i] ?? 0,
  })),
});

const loopView = (prompt: PromptWakeCost[] | undefined): RunLoopView =>
  ({ loop: null, events: [], tries: [], round: null, budget: null, review: null, prompt }) as never;

const seat = (): CrewRow => crewRow({ run: { id: "run-1" } as never });

it("the bar has one segment per section sized by tokens, a label and count for each, and the total", () => {
  render(<PromptCostBar cost={wake(0)} />);
  const bar = screen.getByRole("img", { name: /Prompt tokens by section/ });
  const segments = [...bar.querySelectorAll<HTMLElement>("[data-section]")];
  expect(segments.map((s) => s.dataset.section)).toEqual([...PROMPT_SECTIONS]);
  expect(segments[6]?.style.width).toBe(`${(3000 / 8200) * 100}%`);
  const list = screen.getByRole("list", { name: "Tokens by section" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(7);
  expect(items[0]?.textContent).toContain(PROMPT_SECTION_LABEL.role);
  expect(items[0]?.textContent).toContain("1,200");
  expect(items[6]?.textContent).toContain("Tool results");
  expect(items[6]?.textContent).toContain("3,000");
  expect(screen.getByText("8,200 tokens")).toBeTruthy();
});

it("a section with no tokens keeps its legend row and takes no bar width", () => {
  render(<PromptCostBar cost={wake(0, [100, 0, 0, 0, 0, 0, 0])} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(7);
  const widths = [...document.querySelectorAll<HTMLElement>(".prompt-cost-bar [data-section]")].map(
    (s) => s.style.width,
  );
  expect(widths).toEqual(["100%", "0%", "0%", "0%", "0%", "0%", "0%"]);
});

it("a prompt with no tokens says so, not an empty bar", () => {
  render(<PromptCostBar cost={wake(0, [])} />);
  expect(screen.getByText(NO_SECTION_DATA)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("the Agent tab shows the run's latest prompt as the bar", async () => {
  stubFetch({
    [RESOURCES.runLoop("run-1").path]: loopView([wake(0, [1, 1, 1, 1, 1, 1, 1]), wake(1)]),
  });
  render(<PromptTab row={seat()} />);
  expect(await screen.findByText("8,200 tokens")).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(7);
});

it("the Agent tab says a run from before the accounting has no section data", async () => {
  stubFetch({ [RESOURCES.runLoop("run-1").path]: loopView(undefined) });
  render(<PromptTab row={seat()} />);
  expect(await screen.findByText(NO_SECTION_DATA)).toBeTruthy();
  stubFetch({ [RESOURCES.runLoop("run-1").path]: loopView([]) });
});

it("the Agent tab for a seat with no run names that, and a failed load offers Retry", async () => {
  render(<PromptTab row={crewRow({ run: null })} />);
  expect(screen.getByText("No run yet.")).toBeTruthy();
  stubFetch({
    [RESOURCES.runLoop("run-1").path]: () => ({ status: 500, body: { error: "boom" } }),
  });
  render(<PromptTab row={seat()} />);
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
});

const flightWith = (promptWakes: PromptWakeCost[] | undefined): FlightView =>
  ({ seat: { id: "flight" }, decisions: [], promptWakes }) as never;

it("the FLIGHT panel lists a bar for each wake, newest first", async () => {
  stubFetch({
    [RESOURCES.config.path]: CREW_CONFIG,
    [RESOURCES.flight.path]: flightWith([wake(1), wake(2, [10, 0, 0, 0, 0, 0, 0]), wake(0)]),
  });
  render(<PromptWakes />);
  const list = await screen.findByRole("list", { name: "Prompt cost by wake, newest first" });
  const wakes = within(list).getAllByTestId("prompt-wake");
  expect(wakes).toHaveLength(3);
  // Newest first, whatever order the hub sent.
  expect(wakes.map((w) => w.querySelector("h3")?.textContent)).toEqual([
    expect.stringContaining("Wake 0"),
    expect.stringContaining("Wake 1"),
    expect.stringContaining("Wake 2"),
  ]);
  expect(within(wakes[0] as HTMLElement).getByText("8,200 tokens")).toBeTruthy();
  expect(within(wakes[2] as HTMLElement).getByText("10 tokens")).toBeTruthy();
  expect(wakes[0]?.textContent).toContain(hhmm(NOW, "Europe/London"));
});

it("the FLIGHT panel says there is no section data when no wake was recorded", async () => {
  stubFetch({
    [RESOURCES.config.path]: CREW_CONFIG,
    [RESOURCES.flight.path]: flightWith(undefined),
  });
  render(<PromptWakes />);
  expect(
    await screen.findByText(NO_SECTION_DATA.replace("this run", "FLIGHT's wakes")),
  ).toBeTruthy();
});

it("the FLIGHT panel marks stale figures when a refresh fails", async () => {
  const routes: Record<string, unknown> = {
    [RESOURCES.config.path]: CREW_CONFIG,
    [RESOURCES.flight.path]: flightWith([wake(0)]),
  };
  stubFetch(routes);
  render(<PromptWakes />);
  await screen.findByText("8,200 tokens");
  stubFetch({
    ...routes,
    [RESOURCES.flight.path]: () => ({ status: 500, body: { error: "boom" } }),
  });
  await act(async () => {
    hub.refetch(RESOURCES.flight.path);
  });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Stale"));
  expect(screen.getByText("8,200 tokens")).toBeTruthy();
  fireEvent.click(document.body);
});
