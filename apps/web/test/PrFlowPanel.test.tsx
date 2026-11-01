import { OPERATOR_BOOTSTRAP_PATH, OPERATOR_HEADER } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOperatorToken, loadOperatorToken } from "../src/api.ts";
import { hub } from "../src/data.ts";
import { PrFlowContent, PrFlowPanel, stageDelay } from "../src/flight/PrFlowPanel.tsx";
import { resetSession, setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";
import { FLOW_NOW, prFlowFixture } from "./prFlowFixture.ts";

beforeEach(() => {
  hub.clear();
  resetSession();
  forgetOperatorToken();
});
afterEach(() => {
  cleanup();
  hub.clear();
  resetSession();
  vi.unstubAllGlobals();
});
function routes() {
  return {
    [OPERATOR_BOOTSTRAP_PATH]: { token: "flow-token" },
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [] },
  };
}

describe("PR flow panel", () => {
  it("shows a named loading state", async () => {
    vi.stubGlobal("fetch", (path: string) =>
      path === OPERATOR_BOOTSTRAP_PATH
        ? Promise.resolve(new Response(JSON.stringify({ token: "flow-token" })))
        : new Promise(() => {}),
    );
    await loadOperatorToken();
    render(<PrFlowPanel />);
    expect(screen.getByText("Loading PR flow…").getAttribute("aria-busy")).toBe("true");
  });
  it("reads with the operator token and retries an error", async () => {
    let fail = true;
    stubFetch({
      ...routes(),
      "/api/prs/flow": (init: RequestInit) => ({
        status:
          new Headers(init.headers).get(OPERATOR_HEADER) !== "flow-token" ? 401 : fail ? 502 : 200,
        body: fail ? { error: "offline" } : prFlowFixture(0),
      }),
    });
    render(<PrFlowPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load PR flow: offline",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No open PRs in this session.")).toBeTruthy();
  });
  it("renders one PR with readiness, author, ticket, dependency and last-actor details", async () => {
    const f = prFlowFixture(2);
    f.repos[0]?.rows.shift();
    stubFetch(routes());
    render(<PrFlowContent repos={f.repos} now={FLOW_NOW} />);
    const row = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(row).getByRole("link", { name: "shop-app PR #101" }).getAttribute("href")).toBe(
      "/qa?repo=shop-app&pr=101",
    );
    expect(within(row).getByRole("link", { name: "guido-1" }).getAttribute("href")).toBe(
      "/agent/guido-1",
    );
    expect(within(row).getByRole("link", { name: "shop-app #21" }).getAttribute("href")).toBe(
      "/tickets/shop-app/21",
    );
    expect(row.textContent).toContain("PR 1033 to merge");
    expect(row.textContent).toContain("retro-1");
  });
  it("renders all 50 long rows, with unowned then oldest first, and known summary figures", () => {
    stubFetch(routes());
    render(<PrFlowContent repos={prFlowFixture(50).repos} now={FLOW_NOW} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(50);
    expect(rows[0]?.getAttribute("data-pr")).toBe("shop-app:148");
    expect(rows[12]?.getAttribute("data-pr")).toBe("shop-app:100");
    expect(rows[13]?.getAttribute("data-pr")).toBe("shop-app:149");
    expect(screen.getByText(/Keep the author’s place/)).toBeTruthy();
    const summary = screen.getByLabelText("PR flow summary");
    expect(within(summary).getByText("50")).toBeTruthy();
    expect(within(summary).getByText("13")).toBeTruthy();
    expect(within(summary).getByText("63")).toBeTruthy();
  });
  it("filters repos with the header's session scope", async () => {
    const f = prFlowFixture(1);
    const original = f.repos[0];
    if (!original) throw new Error("fixture missing");
    f.repos.push({
      ...original,
      repoId: "other",
      rows: original.rows.map((r) => ({ ...r, title: "Other repo PR" })),
    });
    setSession("shop-app");
    stubFetch({
      ...routes(),
      "/api/config": { ...CONFIG, crew: { sessions: [{ id: "shop-app", repoId: "shop-app" }] } },
      "/api/prs/flow": f,
    });
    render(<PrFlowPanel />);
    await screen.findByRole("table");
    await waitFor(() => expect(screen.queryByText("Other repo PR")).toBeNull());
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
  it("uses text and per-repo p50/p90 boundaries for stage delays", () => {
    const repo = prFlowFixture(1).repos[0];
    const row = repo?.rows[0];
    if (!repo || !row) throw new Error("fixture missing");
    row.stageSince = FLOW_NOW - 10 * 60_000;
    expect(stageDelay(row, repo.metrics, FLOW_NOW).tone).toBe("plain");
    expect(stageDelay(row, repo.metrics, FLOW_NOW + 1)).toMatchObject({
      tone: "warn",
      reason: "Past stage p50 (10m)",
    });
    row.stageSince = FLOW_NOW - 30 * 60_000;
    expect(stageDelay(row, repo.metrics, FLOW_NOW).tone).toBe("warn");
    expect(stageDelay(row, repo.metrics, FLOW_NOW + 1)).toMatchObject({
      tone: "crit",
      reason: "Past stage p90 (30m)",
    });
    expect(stageDelay(row, [], FLOW_NOW)).toMatchObject({
      tone: "plain",
      reason: "No stage history",
    });
  });
});
