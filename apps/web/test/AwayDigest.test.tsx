import { DEFAULT_AWAY, type AwayDigest as Digest } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { AwayDigest } from "../src/shell/AwayDigest.tsx";
import { AWAY_DIGEST_KEY } from "../src/storage.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW } from "./fixtures.ts";

const digest: Digest = {
  active: false,
  startedAt: NOW - 86400000,
  groups: [
    {
      kind: "needYouNow",
      items: [
        {
          key: "ask",
          kind: "stalled",
          agentId: null,
          repoId: null,
          text: "Please decide",
          tool: null,
          at: NOW,
          url: null,
          escalationId: null,
          ticket: null,
          acked: false,
        },
      ],
    },
    {
      kind: "safePrsReady",
      items: [
        {
          repoId: "demo",
          number: 1,
          title: "Ready guide",
          url: "https://github.com/example/demo/pull/1",
          branch: "guide",
          ticket: null,
          state: "open",
          isDraft: false,
          review: null,
          ci: "passing",
          createdAt: NOW,
          updatedAt: NOW,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
    },
    {
      kind: "draftsToWalkThrough",
      items: [
        {
          repoId: "demo",
          number: 3,
          title: "Draft guide",
          url: "https://github.com/example/demo/pull/3",
          branch: "draft-guide",
          ticket: null,
          state: "open",
          isDraft: true,
          review: null,
          ci: null,
          createdAt: NOW,
          updatedAt: NOW,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
    },
    {
      kind: "failures",
      items: [{ runId: "run-1", ticket: "demo#2", reason: "Verification failed" }],
    },
    {
      kind: "flightDecisions",
      items: [
        {
          id: 1,
          at: NOW,
          kind: "note",
          seatId: null,
          targetRunId: null,
          ref: null,
          questionId: null,
          about: "demo#2",
          decision: "Held in draft",
          basis: "CI is red",
        },
      ],
    },
    {
      kind: "messagesDrafted",
      items: [
        {
          id: 1,
          target: "demo#2",
          kind: "issue",
          text: "Please review",
          createdAt: NOW,
          state: "pending",
        },
      ],
    },
  ],
};

afterEach(() => vi.useRealTimers());

it("renders six linked groups in urgency order, stays dismissed after reload, and separates periods", async () => {
  const fetch = stubFetch({
    "/api/config": CONFIG,
    "/api/settings/away": DEFAULT_AWAY,
    "/api/away/digest": digest,
    [`/api/away/digest?since=${digest.startedAt}`]: digest,
  });
  const view = render(<AwayDigest />);
  const panel = await screen.findByRole("region", { name: "When you come back" });
  expect(
    within(panel)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent),
  ).toEqual([
    "need you now",
    "safe PRs ready for review",
    "drafts to walk through",
    "failed, with the reason",
    "decisions FLIGHT made, with reasons",
    "messages drafted for you",
  ]);
  expect(within(panel).getByText("demo#2: Verification failed")).toBeTruthy();
  expect(within(panel).getByText("CI is red")).toBeTruthy();
  expect(within(panel).getByRole("link", { name: "Ready guide" }).getAttribute("href")).toBe(
    "https://github.com/example/demo/pull/1",
  );
  expect(within(panel).getAllByRole("link")).toHaveLength(6);
  expect(fetch).toHaveBeenCalledWith(
    `/api/away/digest?since=${digest.startedAt}`,
    expect.anything(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge digest" }));
  expect(screen.queryByRole("region")).toBeNull();
  view.unmount();
  hub.clear();
  render(<AwayDigest />);
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.away.path, RESOURCES.away.topic).data).toBeDefined(),
  );
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.awayDigest().path, "settings").data).toBeDefined(),
  );
  expect(screen.queryByRole("region")).toBeNull();
  const next = { ...digest, startedAt: NOW };
  stubFetch({
    "/api/config": CONFIG,
    "/api/settings/away": DEFAULT_AWAY,
    "/api/away/digest": next,
    [`/api/away/digest?since=${NOW}`]: next,
  });
  act(() => hub.refetch(RESOURCES.awayDigest().path));
  await screen.findByRole("region", { name: "When you come back" });
});

it("waits until away is switched off, then shows the digest", async () => {
  let on = true;
  stubFetch({
    "/api/config": CONFIG,
    "/api/settings/away": () => ({ status: 200, body: { ...DEFAULT_AWAY, on } }),
    "/api/away/digest": digest,
    [`/api/away/digest?since=${digest.startedAt}`]: digest,
  });
  render(<AwayDigest />);
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.away.path, RESOURCES.away.topic).data).toBeDefined(),
  );
  expect(screen.queryByRole("region")).toBeNull();
  on = false;
  act(() => hub.refetch(RESOURCES.away.path));
  await screen.findByRole("region", { name: "When you come back" });
});

it("expires after the whole end date in the configured timezone without a settings update", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-18T00:30:00Z"));
  stubFetch({
    "/api/config": { ...CONFIG, operator: { ...CONFIG.operator, timezone: "America/New_York" } },
    "/api/settings/away": { ...DEFAULT_AWAY, on: true, until: "2026-10-17" },
    "/api/away/digest": digest,
    [`/api/away/digest?since=${digest.startedAt}`]: digest,
  });
  await act(async () => {
    render(<AwayDigest />);
  });
  expect(hub.snapshot(RESOURCES.away.path, RESOURCES.away.topic).data).toBeDefined();
  expect(screen.queryByRole("region")).toBeNull();
  vi.setSystemTime(new Date("2026-10-18T04:01:00Z"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await screen.findByRole("region", { name: "When you come back" });
});

it("returns to the unacknowledged digest with Back after opening an item", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/settings/away": DEFAULT_AWAY,
    "/api/away/digest": digest,
    [`/api/away/digest?since=${digest.startedAt}`]: digest,
  });
  render(
    <AwayDigest>
      <p>Item page</p>
    </AwayDigest>,
  );
  await screen.findByRole("region", { name: "When you come back" });
  fireEvent.click(screen.getByRole("link", { name: "Please decide" }));
  expect(window.location.pathname).toBe("/comms/ask");
  expect(screen.getByText("Item page")).toBeTruthy();
  act(() => window.history.back());
  await waitFor(() => expect(window.location.pathname).toBe("/"));
  await screen.findByRole("region", { name: "When you come back" });
  expect(screen.getAllByRole("link")).toHaveLength(6);
  expect(localStorage.getItem(AWAY_DIGEST_KEY)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge digest" }));
  expect(screen.queryByRole("region")).toBeNull();
});

it("uses the observed away start when the server omits startedAt and acknowledges that period", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  let on = true;
  const withoutStart = { ...digest, startedAt: undefined };
  const fetch = stubFetch({
    "/api/config": CONFIG,
    "/api/settings/away": () => ({ status: 200, body: { ...DEFAULT_AWAY, on } }),
    "/api/away/digest": withoutStart,
    [`/api/away/digest?since=${NOW}`]: withoutStart,
    [`/api/away/digest?since=${NOW + 1000}`]: withoutStart,
  });
  render(<AwayDigest />);
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.away.path, RESOURCES.away.topic).data).toBeDefined(),
  );
  expect(screen.queryByRole("region")).toBeNull();
  on = false;
  act(() => hub.refetch(RESOURCES.away.path));
  await screen.findByRole("region", { name: "When you come back" });
  const periodPath = fetch.mock.calls
    .map(([path]) => String(path))
    .find((path) => path.startsWith("/api/away/digest?since="));
  expect(periodPath).toBeDefined();
  expect(periodPath).toBe(`/api/away/digest?since=${NOW}`);
  await screen.findByRole("button", { name: "Acknowledge digest" });
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge digest" }));
  expect(localStorage.getItem(AWAY_DIGEST_KEY)).toBe(periodPath?.split("since=")[1]);
  expect(screen.queryByRole("region")).toBeNull();
  act(() => hub.refetch(RESOURCES.away.path));
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.away.path, RESOURCES.away.topic).data).toBeDefined(),
  );
  expect(screen.queryByRole("region")).toBeNull();
  vi.setSystemTime(NOW + 1000);
  on = true;
  act(() => hub.refetch(RESOURCES.away.path));
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.away.path, RESOURCES.away.topic).data).toMatchObject({
      on: true,
    }),
  );
  on = false;
  act(() => hub.refetch(RESOURCES.away.path));
  await screen.findByRole("button", { name: "Acknowledge digest" });
  expect(fetch).toHaveBeenCalledWith(`/api/away/digest?since=${NOW + 1000}`, expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge digest" }));
  expect(localStorage.getItem(AWAY_DIGEST_KEY)).toBe(String(NOW + 1000));
});

it("does not invent a return period when mounted back without startedAt", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/settings/away": DEFAULT_AWAY,
    "/api/away/digest": { ...digest, startedAt: undefined },
  });
  render(<AwayDigest />);
  await waitFor(() =>
    expect(hub.snapshot(RESOURCES.awayDigest().path, "settings").data).toBeDefined(),
  );
  expect(screen.queryByRole("region")).toBeNull();
});
