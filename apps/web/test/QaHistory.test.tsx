import { OPERATOR_HEADER } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";
import { stubFetch } from "./fetchStub.ts";
import { nativeQaFixture, qaHistoryFixture } from "./qaHistoryFixture.ts";
import { qaReportFixture } from "./qaReportFixture.ts";

beforeEach(() => {
  forgetOperatorToken();
  hub.clear();
  window.history.replaceState(null, "", "/qa?view=history");
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: Date.now() });
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});
it("discovers saved and legacy versions lazily without fetching queue, report bodies or images", async () => {
  const fetch = stubFetch({ "/api/qa/history?limit=50": qaHistoryFixture() });
  render(<QaReadiness />);
  await screen.findAllByText("Independent reviewer");
  expect(screen.getByRole("link", { name: "History" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Current" }).getAttribute("href")).toBe("/qa");
  expect(screen.getByText("No verdict · failed")).toBeTruthy();
  expect(screen.getByText("Time not recorded")).toBeTruthy();
  expect(screen.getByText("Evidence predates saved report")).toBeTruthy();
  const paths = fetch.mock.calls.map((c) => String(c[0]));
  expect(paths).toEqual(["/api/qa/history?limit=50"]);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getAllByRole("link", { name: /Open saved report/ })[0].getAttribute("href")).toBe(
    qaReportFixture().permalink,
  );
});
it("keeps fifty rows bounded and full long identities visibly expandable", async () => {
  const page = qaHistoryFixture(50),
    long = "Very long reviewer and identity ".repeat(30);
  page.entries[0].title = long;
  page.entries[0].reviewer.label = long;
  stubFetch({ "/api/qa/history?limit=50": page });
  render(<QaReadiness />);
  const table = await screen.findByRole("table");
  expect(table.querySelectorAll("tbody tr")).toHaveLength(50);
  expect(screen.getByRole("region", { name: /Past reviews table/ }).getAttribute("tabindex")).toBe(
    "0",
  );
  const identity = screen.getAllByText("Full identity")[0];
  fireEvent.click(identity);
  expect(identity.closest("details")?.textContent).toContain(page.entries[0].headSha);
  expect(identity.closest("details")?.textContent).toContain(long);
  expect(screen.getByRole("link", { name: "Older reviews" }).getAttribute("href")).toContain(
    "cursor=fixture-next-cursor",
  );
});
it("changes repository/page scope and focuses the new page heading without writes", async () => {
  const fetch = stubFetch({
    "/api/qa/history?limit=50": qaHistoryFixture(),
    "/api/qa/history?limit=50&repoId=sample": { ...qaHistoryFixture(0), entries: [] },
  });
  render(<QaReadiness />);
  await screen.findAllByText("Independent reviewer");
  fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), {
    target: { value: "sample" },
  });
  await screen.findByText(/No retained reviews match/);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "QA · Review history" }));
  expect(fetch.mock.calls.every((c) => !c[1]?.method || c[1].method === "GET")).toBe(true);
});
it("opens an old immutable report without a queue entry or approval actions", async () => {
  const report = qaReportFixture();
  window.history.replaceState(null, "", report.permalink);
  const fetch = stubFetch({ [`/api/qa-reports/${report.id}`]: report });
  render(<QaReadiness />);
  await screen.findByText(/Saved historical report/);
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(screen.getByRole("link", { name: "History" }).getAttribute("aria-current")).toBe("page");
  expect(fetch.mock.calls.map((c) => String(c[0]))).not.toContain("/api/qa/queue");
});
it("opens actual native data without fresh CI/report reconstruction or eager screenshot reads", async () => {
  window.history.replaceState(null, "", `/qa?view=history&native=2&identity=${"d".repeat(64)}`);
  const fetch = stubFetch({
    [`/api/qa/history/native/2?identity=${"d".repeat(64)}`]: nativeQaFixture(),
  });
  render(<QaReadiness />);
  await screen.findByText("No verdict · failed", { exact: false });
  expect(screen.getByText(/These are reported counts/)).toBeTruthy();
  expect(screen.getByText(/No historical CI snapshot/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Load recorded screenshot" })).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
    `/api/qa/history/native/2?identity=${"d".repeat(64)}`,
  ]);
});
it("distinguishes loading, empty, stale errors and disconnection from a passed review", async () => {
  let finish: ((r: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<QaReadiness />);
  expect(screen.getByText("Loading review history…")).toBeTruthy();
  await waitFor(() => expect(finish).toBeTruthy());
  await act(async () => {
    finish?.(new Response(JSON.stringify(qaHistoryFixture(0)), { status: 200 }));
  });
  expect(await screen.findByText(/No retained reviews match/)).toBeTruthy();
  await act(async () => {
    streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: 0 });
  });
  expect(screen.getByText(/Disconnected from the hub/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {
    finish?.(new Response(JSON.stringify({ error: "Fixture unavailable" }), { status: 503 }));
  });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Showing the last loaded history page"),
  );
  expect(screen.queryByText(/QA passed/)).toBeNull();
});

it("rejects empty report references without loading the current queue", () => {
  window.history.replaceState(null, "", "/qa?report=");
  const fetch = stubFetch({});
  render(<QaReadiness />);
  expect(screen.getByRole("alert").textContent).toContain("does not match");
  expect(fetch).not.toHaveBeenCalled();
});

it("requests native images with operator auth only on demand and names pruned bytes", async () => {
  window.history.replaceState(null, "", `/qa?view=history&native=2&identity=${"d".repeat(64)}`);
  const fetch = stubFetch({
    [`/api/qa/history/native/2?identity=${"d".repeat(64)}`]: nativeQaFixture(),
    "/api/operator/bootstrap": { token: "fictional-history-key" },
    [`/api/qa/review-shots/${"f".repeat(32)}`]: () => {
      return { status: 404, body: { error: "not found" } };
    },
  });
  render(<QaReadiness />);
  await screen.findByRole("button", { name: "Load recorded screenshot" });
  expect(fetch.mock.calls.map((c) => String(c[0]))).not.toContain("/api/operator/bootstrap");
  fireEvent.click(screen.getByRole("button", { name: "Load recorded screenshot" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("original bytes may have expired"),
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry screenshot" })).toBeTruthy();
  const imageCall = fetch.mock.calls.find(
    ([path]) => path === `/api/qa/review-shots/${"f".repeat(32)}`,
  );
  expect(new Headers(imageCall?.[1]?.headers).get(OPERATOR_HEADER)).toBe("fictional-history-key");
});
