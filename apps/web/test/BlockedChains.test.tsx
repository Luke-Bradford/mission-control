import type { ChainNode, DependencyChain } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub, streamStatus } from "../src/data.ts";
import { BlockedChains } from "../src/flight/BlockedChains.tsx";
import { chainStats, flattenChain, ownerText, waitText } from "../src/flight/chains.ts";
import { stubFetch } from "./fetchStub.ts";

const H = 3_600_000;
const D = 24 * H;
const node = (ref: string, over: Partial<ChainNode> = {}): ChainNode => ({
  ref,
  title: `Title of ${ref}`,
  edge: "depends",
  waitedMs: null,
  alsoWaitsOn: [],
  children: [],
  ...over,
});
const chain = (root: string, over: Partial<DependencyChain> = {}): DependencyChain => ({
  repoId: "mc",
  root: node(root, { edge: null }),
  state: "moving",
  reason: "In review",
  owner: "retro-1",
  seatId: null,
  longestWaitMs: null,
  frees: [],
  stillWaiting: [],
  ...over,
});

const stuck = chain("PR 1033", {
  state: "stuck",
  reason: "No owner for the next step",
  owner: "nobody",
  longestWaitMs: 2 * D + 3 * H,
  frees: ["mc#5", "mc#6"],
  root: node("PR 1033", {
    edge: null,
    children: [
      node("mc#5", { waitedMs: 2 * D + 3 * H }),
      node("mc#6", { waitedMs: D, alsoWaitsOn: ["PR 9"] }),
    ],
  }),
});
const moving = chain("mc#20", {
  seatId: "retro-1",
  longestWaitMs: 4 * H + 30 * 60_000,
  root: node("mc#20", { edge: null, children: [node("mc#21", { waitedMs: 4 * H })] }),
});
const withYou = chain("PR 40", { state: "with-you", owner: "operator", reason: "Waiting for you" });

beforeEach(() => {
  hub.clear();
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: Date.now() });
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});

const serve = (body: unknown, status = 200) =>
  stubFetch({
    "/api/operator/bootstrap": { token: "t" },
    "/api/config": { repos: [{ id: "mc", github: "o/mc" }], operator: { timezone: "UTC" } },
    "/api/dependencies": () => ({ status, body }),
  });

it("words a wait in days and hours, hours and minutes, or minutes; unknown is a dash", () => {
  expect(waitText(2 * D + 3 * H)).toBe("2d 3h");
  expect(waitText(4 * H + 30 * 60_000)).toBe("4h 30m");
  expect(waitText(4 * H)).toBe("4h");
  expect(waitText(12 * 60_000)).toBe("12m");
  expect(waitText(null)).toBe("—");
});

it("counts chains, stuck chains, distinct waiting work and the longest wait", () => {
  const second = chain("mc#30", {
    root: node("mc#30", { edge: null, children: [node("mc#5")] }),
  });
  expect(chainStats([stuck, moving, second])).toEqual({
    chains: 3,
    stuck: 1,
    waiting: 3,
    longestMs: 2 * D + 3 * H,
  });
  expect(chainStats([withYou]).longestMs).toBeNull();
});

it("flattens a chain depth first and shows 4 of 6 dependents behind a {n} more row", () => {
  const six = chain("mc#1", {
    root: node("mc#1", {
      edge: null,
      children: [2, 3, 4, 5, 6, 7].map((n) => node(`mc#${n}`)),
    }),
  });
  const all = flattenChain(six.root);
  expect(all.map((r) => r.node.ref)).toEqual(["mc#2", "mc#3", "mc#4", "mc#5", "mc#6", "mc#7"]);
  expect(all.every((r) => r.depth === 1 && r.parent.ref === "mc#1")).toBe(true);
});

it("shows the six columns word for word, the four stats and the rows in the server's order", async () => {
  serve([stuck, moving, withYou]);
  render(<BlockedChains />);
  await screen.findByRole("table", { name: "Blocked chains" });
  const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(heads.map((h) => h?.replace(/ ▼$/, ""))).toEqual([
    "Work",
    "State",
    "What holds it",
    "Next owner",
    "Waited",
    "Merge frees",
  ]);
  const stats = screen.getByLabelText("Blocked chains summary");
  expect(stats.textContent).toContain("Chains3");
  expect(stats.textContent).toContain("Stuck1of 3");
  expect(stats.textContent).toContain("Waiting3");
  expect(stats.textContent).toContain("Longest wait2d 3h");
  const roots = screen.getAllByRole("row").filter((r) => r.classList.contains("bc-root"));
  expect(roots.map((r) => r.getAttribute("data-ref"))).toEqual(["PR 1033", "mc#20", "PR 40"]);
  expect(within(roots[0] as HTMLElement).getByText("Stuck")).toBeTruthy();
  expect(within(roots[2] as HTMLElement).getByText("With you")).toBeTruthy();
  expect(within(roots[1] as HTMLElement).getByText("Moving")).toBeTruthy();
});

it("links tickets, PRs and the owning seat; an untracked repo stays text", async () => {
  serve([
    stuck,
    chain("mc#20", { seatId: "retro-1", owner: "retro-1", root: node("mc#20", { edge: null }) }),
    chain("legacy#7", { repoId: "legacy", root: node("legacy#7", { edge: null }) }),
  ]);
  render(<BlockedChains />);
  await screen.findByRole("table", { name: "Blocked chains" });
  expect(screen.getAllByRole("link", { name: "PR 1033" })[0]?.getAttribute("href")).toBe(
    "/qa?repo=mc&pr=1033",
  );
  expect(screen.getByRole("link", { name: "mc#5" }).getAttribute("href")).toBe("/tickets/mc/5");
  expect(screen.getByRole("link", { name: "retro-1" }).getAttribute("href")).toBe("/agent/retro-1");
  expect(screen.queryByRole("link", { name: "legacy#7" })).toBeNull();
  expect(screen.getByText("legacy#7")).toBeTruthy();
});

it("caps a chain of more than 5 dependents at 4 and opens the rest from `{n} more`", async () => {
  const many = chain("mc#1", {
    longestWaitMs: H,
    root: node("mc#1", { edge: null, children: [2, 3, 4, 5, 6, 7].map((n) => node(`mc#${n}`)) }),
  });
  serve([many]);
  render(<BlockedChains />);
  await screen.findByText("mc#4");
  expect(screen.queryByText("mc#6")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2 more" }));
  expect(screen.getByText("mc#7")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "2 more" })).toBeNull();
});

it("shows five dependents whole", async () => {
  const five = chain("mc#1", {
    root: node("mc#1", { edge: null, children: [2, 3, 4, 5, 6].map((n) => node(`mc#${n}`)) }),
  });
  serve([five]);
  render(<BlockedChains />);
  await screen.findByText("mc#6");
  expect(screen.queryByText(/more$/)).toBeNull();
});

it("says so when nothing waits", async () => {
  serve([]);
  render(<BlockedChains />);
  expect(await screen.findByText("Nothing is waiting on other work.")).toBeTruthy();
});

it("says it is reading while the first answer is out", () => {
  stubFetch({ "/api/operator/bootstrap": { token: "t" } });
  render(<BlockedChains />);
  expect(screen.getByText("Reading what waits on what…")).toBeTruthy();
});

it("says the read failed and offers Try again", async () => {
  const fetch = serve({ error: "boom" }, 500);
  render(<BlockedChains />);
  expect(await screen.findByText("Blocked chains did not load.")).toBeTruthy();
  const before = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
});

it("keeps the last read and says how old it is when a refresh fails", async () => {
  serve([stuck]);
  render(<BlockedChains />);
  await screen.findByRole("table", { name: "Blocked chains" });
  serve({ error: "boom" }, 500);
  await vi.waitFor(() => hub.refetchAll());
  expect(await screen.findByText(/Showing the last read, \d+ min old\./)).toBeTruthy();
  expect(screen.getByRole("table", { name: "Blocked chains" })).toBeTruthy();
});

it("says the hub is not connected and when the list is from", async () => {
  serve([stuck]);
  render(<BlockedChains />);
  await screen.findByRole("table", { name: "Blocked chains" });
  streamStatus.set({ connected: false, reconnecting: false, lastMessageAt: null });
  expect(
    await screen.findByText(/Not connected to the hub\. This list is from \d\d:\d\d\./),
  ).toBeTruthy();
});

it("says the next owner in the reader's words, from the server's own strings", async () => {
  const owned = (root: string, owner: string, seatId: string | null = null) =>
    chain(root, { owner, seatId, root: node(root, { edge: null }) });
  expect(ownerText("operator")).toBe("You");
  expect(ownerText("nobody")).toBe("—");
  expect(ownerText("controller")).toBe("Controller");
  expect(ownerText("retro-1")).toBe("retro-1");
  serve([
    owned("mc#1", "operator"),
    owned("mc#2", "nobody"),
    owned("mc#3", "controller"),
    owned("mc#4", "retro-1", "retro-1"),
  ]);
  render(<BlockedChains />);
  await screen.findByRole("table", { name: "Blocked chains" });
  const cell = (ref: string) =>
    document.querySelector(`tr.bc-root[data-ref="${ref}"] td:nth-child(4)`) as HTMLElement;
  expect(["mc#1", "mc#2", "mc#3", "mc#4"].map((r) => cell(r).textContent)).toEqual([
    "You",
    "—",
    "Controller",
    "retro-1",
  ]);
  expect(cell("mc#1").querySelector("a")).toBeNull();
  expect(cell("mc#4").querySelector("a")?.getAttribute("href")).toBe("/agent/retro-1");
});

it("sorts longest wait first, unknown last, and ties Stuck first, then by ref", async () => {
  const waited = (root: string, ms: number | null, state: DependencyChain["state"]) =>
    chain(root, { state, longestWaitMs: ms });
  serve([
    waited("mc#7", null, "moving"),
    waited("mc#9", 4 * H, "moving"),
    waited("mc#50", 4 * H, "stuck"),
    waited("mc#8", 2 * D, "moving"),
    waited("mc#10", 4 * H, "moving"),
  ]);
  render(<BlockedChains />);
  await screen.findByRole("table", { name: "Blocked chains" });
  const refs = [...document.querySelectorAll("tr.bc-root")].map((r) => r.getAttribute("data-ref"));
  expect(refs).toEqual(["mc#8", "mc#50", "mc#10", "mc#9", "mc#7"]);
});
