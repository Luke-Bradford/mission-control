import {
  type DependencyChain,
  OPERATOR_BOOTSTRAP_PATH,
  OPERATOR_HEADER,
  OPERATOR_TOKEN_REQUIRED,
} from "@mc/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";
import { stubFetch } from "./fetchStub.ts";

const SHA = "a".repeat(40);
const NOW = Date.now();
const pr = {
  repoId: "mc",
  number: 7,
  title: "Change 7",
  url: "https://github.com/o/mc/pull/7",
  branch: "feature/7",
  ticket: "mc#7",
  state: "open",
  isDraft: false,
  review: "approved",
  ci: "passing",
  createdAt: NOW - 100000,
  updatedAt: NOW,
  mergedAt: null,
  headSha: SHA,
  mergeable: "MERGEABLE",
  uat: { sha: SHA, since: NOW - 3600000 },
};
const chain: DependencyChain = {
  repoId: "mc",
  root: { ref: "PR 7", title: null, edge: null, waitedMs: null, alsoWaitsOn: [], children: [] },
  state: "with-you",
  reason: "",
  owner: "you",
  seatId: null,
  longestWaitMs: null,
  frees: ["mc#1", "mc#2", "mc#3", "mc#4", "mc#5", "mc#6", "mc#8"],
  stillWaiting: ["mc#9", "mc#10"],
};
const routes = {
  [OPERATOR_BOOTSTRAP_PATH]: { token: "dep-token" },
  "/api/qa/queue": { prs: [pr], flightId: "flight-1" },
  [`/api/qa/uat/mc/7?head=${SHA}`]: {
    repoId: "mc",
    number: 7,
    sha: SHA,
    comms: [],
    rounds: [],
    tryIt: { branch: "feature/7", commands: [], previewUrl: null },
    uat: { waiting: true, since: NOW - 3600000, note: null },
  },
  [`/api/repos/mc/prs/7?head=${SHA}`]: { ...pr, checks: [] },
};
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  window.history.replaceState({}, "", "/qa");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});

it("reads dependencies with the operator token and shows the line and the row mark", async () => {
  stubFetch({
    ...routes,
    "/api/dependencies": (init: RequestInit | undefined) =>
      new Headers(init?.headers).get(OPERATOR_HEADER) === "dep-token"
        ? { status: 200, body: [chain] }
        : { status: 401, body: { error: OPERATOR_TOKEN_REQUIRED } },
  });
  render(<QaReadiness />);
  expect(await screen.findByRole("heading", { name: "Merging this frees 7" })).toBeTruthy();
  expect(screen.getByText("+2")).toBeTruthy();
  expect(screen.getByText("2 more also wait on other work")).toBeTruthy();
  expect(screen.getByText(/unblocks 7 ·/)).toBeTruthy();
});

it("does not say nothing waits while the dependencies read is still loading", async () => {
  const fetcher = stubFetch(routes);
  const answer = fetcher.getMockImplementation();
  fetcher.mockImplementation((input: string, init?: RequestInit) =>
    input === "/api/dependencies"
      ? new Promise<Response>(() => {})
      : (answer?.(input, init) as never),
  );
  render(<QaReadiness />);
  expect(await screen.findByText("Reading what this PR frees…")).toBeTruthy();
  expect(screen.queryByText("No recorded work waits on this PR.")).toBeNull();
  expect(screen.queryByText(/unblocks/)).toBeNull();
});
