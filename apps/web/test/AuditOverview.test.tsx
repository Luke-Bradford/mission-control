import { CODE_HEALTH_OVERVIEW_TTL_MS, OPERATOR_HEADER } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub, streamStatus } from "../src/data.ts";
import { Audit } from "../src/pages/Audit.tsx";
import { auditOverviewApi, overviewFixture, proposal, ROW_ID } from "./auditOverviewFixtures.ts";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";
import { codeRiskFixture } from "./codeRiskFixtures.ts";
import { stubFetch } from "./fetchStub.ts";
import { testHealthFixture } from "./testHealthFixtures.ts";

const NOW = Date.UTC(2026, 10, 2, 12);
const OVERVIEW = "/api/code-health/overview?repo=sample&window=30d";
const config = {
  operator: { id: "operator" },
  repos: [
    { id: "sample", github: "example/sample" },
    { id: "other", github: "example/other" },
  ],
};

function setup(extra: Record<string, unknown> = {}) {
  return stubFetch({
    ...codeHealthBrowserApi(NOW),
    ...codeRiskFixture(NOW).api,
    ...testHealthFixture(NOW).api,
    ...auditOverviewApi(NOW),
    ...auditOverviewApi(NOW, "other"),
    "/api/config": config,
    ...extra,
  });
}
const rows = () => [...document.querySelectorAll<HTMLElement>(".ao-row")];
const ready = () => screen.findByRole("heading", { name: "Do next" });
const overviewCalls = (fetch: ReturnType<typeof stubFetch>, path = OVERVIEW) =>
  fetch.mock.calls.filter(([url]) => url === path).length;

beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
  window.history.replaceState(null, "", "/audit");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  hub.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders the verdict and both columns from the stored summary", async () => {
  const fetch = setup();
  render(<Audit />);
  await screen.findByText(/138 of 187 reviewed PRs needed a second round/);
  expect(screen.getByText("Needs attention.")).toBeTruthy();
  for (const name of [
    "Do next",
    "New outside",
    "How we build",
    "Where findings land",
    "What past recommendations achieved",
  ])
    expect(screen.getByRole("heading", { name })).toBeTruthy();
  // Left column: Do next above New outside. Right column: the other three.
  const left = screen.getByRole("heading", { name: "Do next" }).closest(".ao-col");
  expect(left?.querySelector("#page-audit .ao-outside, .ao-outside")).not.toBeNull();
  expect(within(left as HTMLElement).queryByRole("heading", { name: "How we build" })).toBeNull();
  // Reads one stored summary, with the operator header, and never the five-tab read.
  const request = fetch.mock.calls.find(([url]) => url === OVERVIEW);
  expect(new Headers(request?.[1]?.headers).get(OPERATOR_HEADER)).toBe("fictional-operator-token");
  expect(fetch.mock.calls.some(([url]) => String(url).startsWith("/api/code-health?"))).toBe(false);
  expect(screen.getByText(/Outside sources .* are not collected yet/)).toBeTruthy();
  expect(screen.getByText("Partly measured: 90 of 120")).toBeTruthy();
  expect(screen.getByText("Reviewed PRs reaching round 2")).toBeTruthy();
  expect(screen.getByText("RETRO must record a category")).toBeTruthy();
});

it("lists eight ranked rows with the first expanded", async () => {
  setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  expect(screen.getByText(/ranked ·/).textContent).toContain("8");
  const buttons = rows().map((r) => r.querySelector(".rt")?.getAttribute("aria-expanded"));
  expect(buttons).toEqual(["true", ...Array(7).fill("false")]);
  expect(document.querySelectorAll(".ao-more")).toHaveLength(1);
});

it("shows measure, decider, state and review date on every row, and the rest in the detail", async () => {
  setup({
    [OVERVIEW]: overviewFixture(NOW, {
      over: {
        rows: [
          proposal(0, NOW),
          proposal(1, NOW),
          proposal(2, NOW, "sample", {
            state: {
              kind: "accepted",
              owner: "operator",
              reviewAt: Date.UTC(2026, 10, 18),
              linkedWork: null,
            },
          }),
        ],
      },
    }),
  });
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(3));
  const [first, second, third] = rows() as [HTMLElement, HTMLElement, HTMLElement];
  expect(first.textContent).toContain("Merged PRs with a hub review");
  expect(first.textContent).toContain("3% → 95%");
  expect(first.textContent).toContain("FLIGHT");
  expect(first.textContent).toContain("Proposed · Review date unset");
  expect(second.textContent).toContain("You");
  expect(second.textContent).toContain("not measured → 1");
  expect(third.textContent).toContain("Accepted · Review 18 Nov");
  const detail = document.querySelector<HTMLElement>(".ao-more") as HTMLElement;
  expect(within(detail).getByText("Why believe it")).toBeTruthy();
  expect(within(detail).getByText("What could be wrong")).toBeTruthy();
  expect(within(detail).getByText(/Fresh-agent reviews by the controller/)).toBeTruthy();
  expect(within(detail).getByText("Risks")).toBeTruthy();
  expect(within(detail).getByText("State path")).toBeTruthy();
  expect(within(detail).getByText("Proposed").getAttribute("aria-current")).toBe("step");
});

it("expands one row at a time and filters by the server's decider", async () => {
  setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  fireEvent.click(rows()[1]?.querySelector(".rt") as HTMLElement);
  expect(rows().map((r) => r.querySelector(".rt")?.getAttribute("aria-expanded"))[0]).toBe("false");
  expect(screen.getByRole("button", { name: "Inspect evidence for rank 2" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Yours 3" }));
  expect(rows().map((r) => r.querySelector(".n")?.textContent)).toEqual(["2", "7", "8"]);
  fireEvent.click(screen.getByRole("button", { name: "FLIGHT's 5" }));
  expect(rows().map((r) => r.querySelector(".n")?.textContent)).toEqual(["1", "3", "4", "5", "6"]);
  fireEvent.click(screen.getByRole("button", { name: "All 8" }));
  expect(rows()).toHaveLength(8);
});

it("says so when there are no ranked rows, and counts one row as one", async () => {
  setup({ [OVERVIEW]: overviewFixture(NOW, { rows: 0 }) });
  render(<Audit />);
  await screen.findByText(/No open proposal meets the measured triage rules/);
  expect(rows()).toHaveLength(0);
  expect(screen.getByText(/ranked ·/).textContent).toContain("0");
  cleanup();
  hub.clear();
  setup({ [OVERVIEW]: overviewFixture(NOW, { rows: 1 }) });
  render(<Audit />);
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(screen.getByText(/ranked ·/).textContent).toContain("1");
  expect(screen.getByRole("button", { name: "Yours 0" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Yours 0" }));
  expect(screen.getByText(/None of the 1 ranked rows is decided by you/)).toBeTruthy();
});

it("keeps all fifty rows reachable in a labelled, focusable scroller", async () => {
  setup({ [OVERVIEW]: overviewFixture(NOW, { rows: 50 }) });
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(50));
  const scroller = screen.getByRole("region", { name: "Ranked recommendations" });
  expect(scroller.getAttribute("tabindex")).toBe("0");
  expect(scroller.contains(rows()[49] as HTMLElement)).toBe(true);
  expect(rows()[49]?.querySelector(".n")?.textContent).toBe("50");
});

it("keeps a long title whole for a reader and clamps it on screen", async () => {
  const long = `Replace the hand-kept list ${"of every write tool and its callers ".repeat(8)}`;
  setup({
    [OVERVIEW]: overviewFixture(NOW, {
      over: { rows: [proposal(0, NOW, "sample", { title: long })] },
    }),
  });
  render(<Audit />);
  await ready();
  const clamp = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(".ao-row .rt .clamp");
    if (!found) throw new Error("not yet");
    return found;
  });
  expect(clamp.getAttribute("title")).toBe(long);
  expect(
    screen.getByRole("button", { name: new RegExp(`Accept: ${long.slice(0, 20)}`) }),
  ).toBeTruthy();
});

it("reads again for a new window and repo and closes what was open", async () => {
  const fetch = setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  fireEvent.click(screen.getAllByRole("button", { name: /^Accept:/ })[0] as HTMLElement);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getAllByRole("button", { name: /^Dismiss:/ })[0] as HTMLElement);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() =>
    expect(overviewCalls(fetch, "/api/code-health/overview?repo=sample&window=7d")).toBe(1),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: /Repo/ }), { target: { value: "other" } });
  await waitFor(() =>
    expect(overviewCalls(fetch, "/api/code-health/overview?repo=other&window=7d")).toBe(1),
  );
  expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(rows()).toHaveLength(8));
});

it("blocks decisions on an error and never shows the other scope's rows", async () => {
  setup({ [OVERVIEW]: () => ({ status: 503, body: { error: "Collection offline" } }) });
  render(<Audit />);
  await screen.findByText(/The summary could not be read: Collection offline/);
  expect(rows()).toHaveLength(0);
  expect(screen.getByText("Stale summary")).toBeTruthy();
});

it("marks a summary older than the hub keeps it as stale and turns decisions off", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW + CODE_HEALTH_OVERVIEW_TTL_MS + 61_000);
  setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  expect(screen.getByText("Stale summary")).toBeTruthy();
  expect(screen.getByText(/older than the hub keeps it/)).toBeTruthy();
  for (const b of screen.getAllByRole("button", { name: /^Accept:/ }))
    expect((b as HTMLButtonElement).disabled).toBe(true);
});

it("turns decisions off while disconnected and back on after the stream returns", async () => {
  const fetch = setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  const accept = () => screen.getAllByRole("button", { name: /^Accept:/ })[0] as HTMLButtonElement;
  expect(accept().disabled).toBe(false);
  act(() => streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: NOW }));
  expect(screen.getByText("Disconnected")).toBeTruthy();
  expect(accept().disabled).toBe(true);
  expect(rows()).toHaveLength(8);
  act(() => streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: NOW }));
  await waitFor(() => expect(accept().disabled).toBe(false));
  // Only the health topic reads the summary again; crew events do not.
  const before = overviewCalls(fetch);
  act(() => hub.refetchTopic("agents"));
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  expect(overviewCalls(fetch)).toBe(before);
  act(() => hub.refetchTopic("health"));
  await waitFor(() => expect(overviewCalls(fetch)).toBe(before + 1));
});

it("records an accepted decision and says FLIGHT's work is pending", async () => {
  const bodies: unknown[] = [];
  const first = proposal(0, NOW);
  setup({
    [`POST /api/code-health/recommendations/${ROW_ID(0)}?repo=sample`]: (
      init: RequestInit | undefined,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return {
        status: 200,
        body: {
          ...first,
          state: {
            kind: "accepted",
            owner: "operator",
            reviewAt: NOW + 7 * 86_400_000,
            linkedWork: null,
          },
        },
      };
    },
  });
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  fireEvent.click(screen.getAllByRole("button", { name: /^Accept:/ })[0] as HTMLElement);
  fireEvent.click(await screen.findByRole("button", { name: "Record decision" }));
  await screen.findByText(/Decision recorded: accepted\. FLIGHT work is pending/);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    expectedUpdatedAt: NOW,
    change: { action: "accept", owner: "operator" },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows a decision as pending until the server answers, then as unconfirmed when it fails", async () => {
  let release: (() => void) | undefined;
  let attempts = 0;
  setup({
    [`POST /api/code-health/recommendations/${ROW_ID(0)}?repo=sample`]: () => {
      attempts++;
      return attempts === 1
        ? new Promise((resolve) => {
            release = () =>
              resolve({ status: 503, body: { error: "Temporary collection failure" } });
          })
        : { status: 503, body: { error: "Temporary collection failure" } };
    },
  });
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  fireEvent.click(screen.getAllByRole("button", { name: /^Dismiss:/ })[0] as HTMLElement);
  fireEvent.change(await screen.findByRole("textbox", { name: "Reason" }), {
    target: { value: "Not now" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  await screen.findByText(/Recording decision/);
  await act(async () => release?.());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This decision is not confirmed");
  expect(screen.queryByText(/Decision recorded/)).toBeNull();
});

it("opens a row's evidence from the full read, on demand", async () => {
  const fetch = setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  expect(fetch.mock.calls.some(([url]) => String(url).includes("tab=overview"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Inspect evidence for rank 1" }));
  await screen.findByRole("dialog");
  // The loading notice gives way to the evidence dialog, a new element: query again, never keep the first.
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).getByText("Reported review cohort")).toBeTruthy(),
  );
  expect(
    fetch.mock.calls.some(
      ([url]) => url === "/api/code-health?repo=sample&window=30d&tab=overview",
    ),
  ).toBe(true);
});

it("opens recommendation history from the Do next panel", async () => {
  setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  fireEvent.click(screen.getByRole("button", { name: "Recommendation history" }));
  await screen.findByRole("dialog");
});

it("reaches every earlier Audit view in one click and returns with the same repo and window", async () => {
  setup();
  render(<Audit />);
  await ready();
  await waitFor(() => expect(rows()).toHaveLength(8));
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  const opened: [string, () => HTMLElement | Promise<HTMLElement>][] = [
    ["Review quality", () => screen.findByRole("tab", { name: "Review quality" })],
    ["Code risk", () => screen.findByRole("tab", { name: "Code risk" })],
    ["Test health", () => screen.findByRole("tab", { name: "Test health" })],
    ["Tokens", () => screen.findByRole("tab", { name: "Tokens" })],
  ];
  for (const [name, find] of opened) {
    fireEvent.click(await screen.findByRole("button", { name }));
    const tab = await find();
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Overview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to overview" }));
    await ready();
    expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  }
  fireEvent.click(screen.getByRole("button", { name: "Workflow history" }));
  await screen.findByText("Workflow history and earlier proposals");
  fireEvent.click(screen.getByRole("button", { name: "Back to overview" }));
  await ready();
  expect(screen.getByRole("link", { name: "Cost and flow context" }).getAttribute("href")).toBe(
    "/telemetry",
  );
  expect(
    screen.getByRole("link", { name: "PR readiness and tests in QA" }).getAttribute("href"),
  ).toBe("/qa");
});

it("opens straight on Code risk at /audit?tab=risk", async () => {
  window.history.replaceState(null, "", "/audit?tab=risk");
  setup();
  render(<Audit />);
  const tab = await screen.findByRole("tab", { name: "Code risk" });
  expect(tab.getAttribute("aria-selected")).toBe("true");
});
