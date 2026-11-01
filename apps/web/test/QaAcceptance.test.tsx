import type { PrUatView, PullRequestView } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";
import { stubFetch } from "./fetchStub.ts";

const SHA = "a".repeat(40);
const NOW = Date.now();
const pr = (n: number, since: number | null): PullRequestView => ({
  repoId: "mc",
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/o/mc/pull/${n}`,
  branch: `feature/${n}`,
  ticket: `mc#${n}`,
  state: "open",
  isDraft: false,
  review: "approved",
  ci: "passing",
  createdAt: NOW - 100000,
  updatedAt: NOW,
  mergedAt: null,
  headSha: SHA,
  mergeable: "MERGEABLE",
  ...(since === null ? {} : { uat: { sha: SHA, since } }),
});
let rows: PullRequestView[];
let details: PrUatView;
let fullHead: string;
let refuse = false;
let fetcher: ReturnType<typeof stubFetch>;
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  window.history.replaceState({}, "", "/qa");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
  rows = [pr(1, NOW - 3600000), pr(2, NOW - 7200000), pr(3, null)];
  fullHead = SHA;
  refuse = false;
  details = {
    repoId: "mc",
    number: 2,
    sha: SHA,
    comms: [],
    rounds: [],
    tryIt: { branch: "feature/2", commands: ["pnpm dev"], previewUrl: null },
    uat: { waiting: true, since: NOW - 7200000, note: null },
  };
  fetcher = stubFetch({
    "/api/operator/bootstrap": { token: "token" },
    "/api/qa/queue": () => ({ status: 200, body: { prs: rows, flightId: "flight-1" } }),
    [`/api/qa/uat/mc/2?head=${SHA}`]: () => ({ status: 200, body: details }),
    [`/api/repos/mc/prs/2?head=${SHA}`]: () => ({
      status: 200,
      body: { ...rows[1], headSha: fullHead },
    }),
    "POST /api/prs/mc/2/uat": () =>
      refuse
        ? {
            status: 409,
            body: { error: "the PR head changed; reload its evidence before deciding" },
          }
        : { status: 200, body: { ok: true } },
    "POST /api/comms": (init: RequestInit | undefined) => {
      const input = JSON.parse(String(init?.body));
      details = {
        ...details,
        comms: [
          {
            id: "comms:2",
            at: NOW,
            from: "flight-1",
            to: "CAPCOM",
            label: null,
            text: "QA checked both themes.",
          },
          {
            id: "comms:1",
            at: NOW,
            from: "CAPCOM",
            to: "flight-1",
            label: "question",
            text: input.text,
          },
        ],
      };
      return { status: 200, body: { message: details.comms[1] } };
    },
  });
});
afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function ready() {
  render(<QaReadiness />);
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}
const posts = (path: string) =>
  fetcher.mock.calls.filter(([p, i]) => p === path && i?.method === "POST");
describe("QA acceptance", () => {
  it("orders waiting PRs by their UAT entry time and shows ages", async () => {
    await ready();
    const links = within(
      screen.getByRole("list", { name: "Pull requests in UAT, oldest first" }),
    ).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/qa?repo=mc&pr=2",
      "/qa?repo=mc&pr=1",
    ]);
    expect(links[0]?.textContent).toMatch(/2h/);
    expect(screen.getByRole("list", { name: "Pull requests in review" }).textContent).toContain(
      "Change 3",
    );
    expect(fetcher.mock.calls.filter(([path]) => path.startsWith("/api/qa/uat/"))).toHaveLength(1);
  });
  it("accepts only the displayed immutable head, once", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText(/Accepted for this head/);
    expect(posts("/api/prs/mc/2/uat")).toHaveLength(1);
    expect(JSON.parse(String(posts("/api/prs/mc/2/uat")[0]?.[1]?.body))).toEqual({
      action: "accept",
      sha: SHA,
    });
  });
  it("requires a nonblank send-back note and submits it with the displayed head", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Send back…" }));
    const send = screen.getByRole("button", {
      name: "Send back with this note",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Note to the author (required)"), {
      target: { value: "  " },
    });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Note to the author (required)"), {
      target: { value: "  The button overlaps.  " },
    });
    fireEvent.click(send);
    await screen.findByText(/Sent back with your note/);
    expect(JSON.parse(String(posts("/api/prs/mc/2/uat")[0]?.[1]?.body))).toEqual({
      action: "send_back",
      sha: SHA,
      note: "The button overlaps.",
    });
  });
  it("disables decisions and questions when disconnected", async () => {
    await ready();
    act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: NOW }));
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Ask QA" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("does not decide when the detail response has moved to a different head", async () => {
    fullHead = "b".repeat(40);
    render(<QaReadiness />);
    await screen.findByText("No messages for this PR yet.");
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(posts("/api/prs/mc/2/uat")).toHaveLength(0);
  });
  it("shows the server's stale-head refusal", async () => {
    refuse = true;
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(
      await screen.findByText("the PR head changed; reload its evidence before deciding"),
    ).toBeTruthy();
    expect(screen.queryByText(/Accepted for this head/)).toBeNull();
  });
  it("posts Ask QA to FLIGHT with the PR ref and shows the question and answer", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Ask QA about this PR"), {
      target: { value: "Which themes did you check?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask QA" }));
    await screen.findByText("QA checked both themes.");
    expect(screen.getByText("mc PR #2: Which themes did you check?")).toBeTruthy();
    expect(JSON.parse(String(posts("/api/comms")[0]?.[1]?.body))).toEqual({
      to: "flight-1",
      label: "question",
      ref: "PR 2",
      repoId: "mc",
      text: "mc PR #2: Which themes did you check?",
    });
  });
});
