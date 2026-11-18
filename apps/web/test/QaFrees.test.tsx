import type { DependencyChain } from "@mc/core";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { chainFor, FreesLine, UnblocksMark } from "../src/qa/frees.tsx";

const chain = (over: Partial<DependencyChain> = {}): DependencyChain => ({
  repoId: "mission-control",
  root: { ref: "PR 1033", title: null, edge: null, waitedMs: null, alsoWaitsOn: [], children: [] },
  state: "with-you",
  reason: "",
  owner: "you",
  seatId: null,
  longestWaitMs: null,
  frees: [],
  stillWaiting: [],
  ...over,
});
const pr = { repoId: "mission-control", number: 1033, ticket: null };

it("names what a merge frees, five refs and a count for the rest", () => {
  const frees = ["a#1", "a#2", "a#3", "a#4", "a#5", "a#6", "a#7"];
  render(<FreesLine chain={chain({ frees, stillWaiting: ["a#8", "a#9"] })} repoId="a" />);
  expect(screen.getByRole("heading", { name: "Merging this frees 7" })).toBeTruthy();
  expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual([
    "a#1",
    "a#2",
    "a#3",
    "a#4",
    "a#5",
    "+2",
  ]);
  expect(screen.getByText("2 more also wait on other work")).toBeTruthy();
});

it("says what waits on other work when nothing is freed outright", () => {
  render(<FreesLine chain={chain({ stillWaiting: ["a#8"] })} repoId="a" />);
  expect(screen.getByText("1 more also wait on other work")).toBeTruthy();
});

it("shows nothing when there is no chain", () => {
  const { container } = render(<FreesLine chain={undefined} repoId="a" />);
  expect(container.textContent).toBe("");
});

it("finds a PR's chain by its number or its ticket, in its own repo", () => {
  const other = chain({ repoId: "demo" });
  const own = chain({ frees: ["x#1"] });
  expect(chainFor([other, own], pr)).toBe(own);
  const byTicket = chain({ root: { ...own.root, ref: "mission-control#1575" } });
  expect(chainFor([byTicket], { ...pr, ticket: "mission-control#1575" })).toBe(byTicket);
  expect(chainFor([other], pr)).toBeUndefined();
});

it("marks a queue row only when its merge frees something", () => {
  const { container, rerender } = render(<UnblocksMark count={3} />);
  expect(container.textContent).toBe("unblocks 3 · ");
  rerender(<UnblocksMark count={0} />);
  expect(container.textContent).toBe("");
});
