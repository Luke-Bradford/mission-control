import type { PrUatView, PullRequestView, QaReport } from "@mc/core";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";
import { stubFetch } from "./fetchStub.ts";
import { qaReportFixture } from "./qaReportFixture.ts";

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
  isDraft: since === null,
  review: null,
  ci: "passing",
  createdAt: NOW - 100000,
  updatedAt: NOW,
  mergedAt: null,
  headSha: SHA,
  mergeable: "MERGEABLE",
  ...(since === null ? {} : { uat: { sha: SHA, since } }),
});
const detail = (n: number, waiting: boolean): PrUatView => ({
  repoId: "mc",
  number: n,
  sha: SHA,
  comms: [],
  rounds: [],
  tryIt: { branch: `feature/${n}`, commands: [], previewUrl: null },
  uat: { waiting, since: waiting ? NOW - 1000 : null, note: null },
});
const report: QaReport = {
  ...qaReportFixture(),
  repoId: "mc",
  prNumber: 1,
  headSha: SHA,
  completeness: { state: "incomplete", missing: ["No browser check"] },
};

let rows: PullRequestView[];
function serve(extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/operator/bootstrap": { token: "token" },
    "/api/qa/queue": () => ({ status: 200, body: { prs: rows, flightId: "flight-1" } }),
    "/api/dependencies": () => ({ status: 200, body: [] }),
    [`/api/qa/uat/mc/1?head=${SHA}`]: detail(1, true),
    [`/api/qa/uat/mc/3?head=${SHA}`]: detail(3, false),
    [`/api/repos/mc/prs/1?head=${SHA}`]: { ...pr(1, NOW), checks: [] },
    [`/api/repos/mc/prs/3?head=${SHA}`]: { ...pr(3, null), checks: [] },
    [`/api/prs/1/evidence?repo=mc&sha=${SHA}`]: () => ({ status: 404, body: { error: "none" } }),
    [`/api/prs/3/evidence?repo=mc&sha=${SHA}`]: () => ({ status: 404, body: { error: "none" } }),
    [`/api/qa-reports?repoId=mc&prNumber=1&headSha=${SHA}`]: { reports: [report] },
    [`/api/qa-reports?repoId=mc&prNumber=3&headSha=${SHA}`]: {
      reports: [{ ...report, prNumber: 3 }],
    },
    ...extra,
  });
}
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  window.history.replaceState({}, "", "/qa");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
});
afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
});

describe("QA page when nothing waits", () => {
  it("opens no PR and says so in one line", async () => {
    rows = [pr(3, null)];
    const fetcher = serve();
    render(<QaReadiness />);
    expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByText(/Could not read what this PR frees/)).toBeNull();
    expect(screen.queryByText("Missing evidence")).toBeNull();
    expect(fetcher.mock.calls.some(([p]) => String(p).startsWith("/api/qa/uat/"))).toBe(false);
  });
  it("opens a PR in review only when it is clicked, without decision buttons", async () => {
    rows = [pr(3, null)];
    window.history.replaceState({}, "", "/qa?repo=mc&pr=3");
    serve();
    render(<QaReadiness />);
    await screen.findByRole("heading", { name: "Change 3" });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send back…" })).toBeNull();
    expect(screen.queryByText("Missing evidence")).toBeNull();
    expect(screen.queryByText(/Could not read what this PR frees/)).toBeNull();
    expect(screen.queryByText("No recorded work waits on this PR.")).toBeNull();
  });
  it("does not say nothing needs you after the queue read failed", async () => {
    rows = [];
    serve({ "/api/qa/queue": () => ({ status: 500, body: { error: "down" } }) });
    render(<QaReadiness />);
    await screen.findByText(/The queue did not load/);
    expect(screen.queryByText("Nothing needs you right now.")).toBeNull();
  });
  it("does not say nothing needs you while the queue is loading", async () => {
    rows = [];
    serve({ "/api/qa/queue": () => new Promise(() => {}) });
    render(<QaReadiness />);
    await screen.findByText("Loading the acceptance queue…");
    expect(screen.queryByText("Nothing needs you right now.")).toBeNull();
  });
  it("shows an error line for the frees read only when it failed", async () => {
    rows = [pr(1, NOW - 1000)];
    serve({ "/api/dependencies": () => ({ status: 500, body: { error: "down" } }) });
    render(<QaReadiness />);
    const line = await screen.findByText("Could not read what this PR frees.");
    expect(line.classList.contains("uat-frees")).toBe(false);
  });
  it("shows decisions and missing evidence for a waiting PR with a current report", async () => {
    rows = [pr(1, NOW - 1000), pr(3, null)];
    serve();
    render(<QaReadiness />);
    await screen.findByText("Missing evidence");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.getByRole("button", { name: "Send back…" })).toBeTruthy();
  });
});
