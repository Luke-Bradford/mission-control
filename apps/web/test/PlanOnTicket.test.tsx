import type { TicketHistory } from "@mc/core";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOperatorToken } from "../src/api.ts";
import { hub } from "../src/data.ts";
import { TicketPage } from "../src/pages/TicketPage.tsx";
import type { Plan, PlansView } from "../src/plans/types.ts";
import { QaReportRead } from "../src/qa/QaReport.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";
import { qaReportFixture, ticketQaReportFixture } from "./qaReportFixture.ts";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  hub.clear();
  forgetOperatorToken();
});

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const plan = (over: Partial<Plan>): Plan => ({
  id: "p1",
  repoId: "shop-app",
  ticket: "shop-app#3349",
  title: "Quote cache",
  asks: "Quotes are slow.",
  proposed: "Cache the quote total.",
  pictures: [{ url: `/api/attention-material-assets/${"a".repeat(64)}`, caption: "Quote mockup" }],
  size: "M",
  risks: "Stale totals.",
  status: "approved",
  decidedAt: 10,
  ...over,
});

function serve(routes: Record<string, unknown>) {
  const fn = stubFetch({ "/api/operator/bootstrap": { token: "t" }, ...routes });
  const inner = fn.getMockImplementation() as (i: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) =>
      input.startsWith("/api/attention-material-assets/")
        ? new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } })
        : inner(input, init),
    ),
  );
}

const ticket = (): TicketHistory =>
  ({
    repoId: "shop-app",
    number: 3349,
    url: "https://github.com/octo-org/shop-app/issues/3349",
    title: "Quote cache",
    state: "open",
    status: "In progress",
    priority: "p1",
    size: "M",
    labels: [],
    outcome: "Quotes load from the cache.",
    doneWhen: [{ text: "Hit under 5 ms", checked: true }],
    body: "",
    bodyTruncated: false,
    githubError: null,
    runs: [],
    prs: [],
    timeline: [],
    nextBefore: null,
  }) as unknown as TicketHistory;

describe("the signed-off plan beside what was built", () => {
  it("shows on the ticket page: the proposal against saved QA evidence, with its mockup", async () => {
    const view: PlansView = {
      pending: [],
      history: [
        plan({ id: "old", decidedAt: 1, proposed: "Old idea" }),
        plan({}),
        plan({ id: "x", ticket: "shop-app#1" }),
      ],
    };
    const report = ticketQaReportFixture();
    const ticketWithPr = {
      ...ticket(),
      prs: [
        {
          number: 40,
          url: "https://github.com/octo-org/shop-app/pull/40",
          title: "Cache quotes",
          state: "open",
          isDraft: false,
          branch: "feature/3349-cache-quotes",
          headSha: "a".repeat(40),
          createdAt: 1,
          mergedAt: null,
          rounds: [],
          ci: [],
        },
      ],
    } as TicketHistory;
    serve({
      "/api/config": CONFIG,
      "/api/tickets/shop-app/3349": ticketWithPr,
      "/api/plans?repoId=shop-app": view,
      "/api/qa-reports?repoId=shop-app&prNumber=40": { reports: [report] },
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByText("Cache the quote total.")).toBeTruthy();
    expect(within(panel).queryByText("Old idea")).toBeNull();
    const built = within(panel).getByRole("region", { name: "What was built" });
    expect(built.textContent).toContain(report.summary);
    expect(built.textContent).not.toContain("Quotes load from the cache.");
    expect(await within(built).findByRole("img", { name: /Built · Overview/ })).toBeTruthy();
    expect(await within(panel).findByRole("img", { name: "Quote mockup" })).toBeTruthy();
  });

  it("shows nothing on the ticket page when the plan is not approved", async () => {
    serve({
      "/api/config": CONFIG,
      "/api/tickets/shop-app/3349": ticket(),
      "/api/plans?repoId=shop-app": {
        pending: [plan({ status: "pending" })],
        history: [plan({ status: "sent-back" })],
      },
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    await screen.findByRole("heading", { name: "Quote cache" });
    expect(screen.queryByRole("region", { name: "Signed-off plan" })).toBeNull();
  });

  it("says when a signed-off plan has no QA report to compare", async () => {
    const ticketWithPr = {
      ...ticket(),
      prs: [
        {
          number: 40,
          url: "https://github.com/octo-org/shop-app/pull/40",
          title: "Cache quotes",
          state: "open",
          isDraft: false,
          branch: "feature/3349-cache-quotes",
          headSha: "a".repeat(40),
          createdAt: 1,
          mergedAt: null,
          rounds: [],
          ci: [],
        },
      ],
    } as TicketHistory;
    serve({
      "/api/config": CONFIG,
      "/api/tickets/shop-app/3349": ticketWithPr,
      "/api/plans?repoId=shop-app": { pending: [], history: [plan({})] },
      "/api/qa-reports?repoId=shop-app&prNumber=40": { reports: [] },
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByText("No QA report yet: nothing built to compare.")).toBeTruthy();
  });

  it("shows on the QA report, against the report's own result", async () => {
    const report = qaReportFixture();
    serve({
      "/api/plans?repoId=mission-control": {
        pending: [],
        history: [plan({ repoId: "mission-control", ticket: "mission-control#2037" })],
      },
    });
    render(<QaReportRead report={report} ticket="mission-control#2037" />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByText("Cache the quote total.")).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "What was built" }).textContent).toContain(
      report.summary,
    );
  });

  it("finds the ticket of an archived report from its branch", async () => {
    const report = { ...qaReportFixture(), branch: "feature/2037-planner-tab" };
    serve({
      "/api/plans?repoId=mission-control": {
        pending: [],
        history: [plan({ repoId: "mission-control", ticket: "mission-control#2037" })],
      },
    });
    render(<QaReportRead report={report} archived />);
    expect(await screen.findByRole("region", { name: "Signed-off plan" })).toBeTruthy();
  });

  const signed = {
    pending: [],
    history: [plan({ repoId: "mission-control", ticket: "mission-control#2037" })],
  };
  const PR = "/api/repos/mission-control/prs/1011";
  const prRow = (ticket: string | null) => ({ repoId: "mission-control", number: 1011, ticket });

  it("finds the plan of an archived report that has no branch, from the PR's ticket", async () => {
    const report = qaReportFixture();
    expect(report.branch).toBeUndefined();
    serve({ "/api/plans?repoId=mission-control": signed, [PR]: prRow("mission-control#2037") });
    render(<QaReportRead report={report} archived />);
    expect(await screen.findByRole("region", { name: "Signed-off plan" })).toBeTruthy();
  });

  it("finds it when the branch name does not carry the ticket", async () => {
    const report = { ...qaReportFixture(), branch: "inco-1-planner" };
    serve({ "/api/plans?repoId=mission-control": signed, [PR]: prRow("mission-control#2037") });
    render(<QaReportRead report={report} archived />);
    expect(await screen.findByRole("region", { name: "Signed-off plan" })).toBeTruthy();
  });

  it("shows nothing for an archived report whose ticket cannot be found", async () => {
    serve({ "/api/plans?repoId=mission-control": signed, [PR]: prRow(null) });
    render(<QaReportRead report={qaReportFixture()} archived />);
    await screen.findByRole("article");
    expect(screen.queryByRole("region", { name: "Signed-off plan" })).toBeNull();
  });

  it("names a retained PR lookup that is still loading", async () => {
    serve({ [PR]: () => new Promise(() => {}) });
    render(<QaReportRead report={qaReportFixture()} archived />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByRole("status").textContent).toMatch(/Finding this report's ticket/);
  });

  it("explains a failed retained PR lookup", async () => {
    serve({ [PR]: () => ({ status: 503, body: { error: "PR lookup offline" } }) });
    render(<QaReportRead report={qaReportFixture()} archived />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByRole("alert").textContent).toMatch(/Could not find this report's ticket/);
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("puts the report's result screenshots in the Built column, beside the mockups", async () => {
    const report = qaReportFixture();
    serve({ "/api/plans?repoId=mission-control": signed });
    render(<QaReportRead report={report} ticket="mission-control#2037" />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    const built = within(panel).getByRole("region", { name: "What was built" });
    expect(built.textContent).toContain(`Built · ${report.visual.pairs[0].label}`);
    expect(within(panel).getByRole("region", { name: "What was proposed" })).toBeTruthy();
  });

  it("explains a failed signed-off plan read on the ticket page", async () => {
    serve({
      "/api/config": CONFIG,
      "/api/tickets/shop-app/3349": ticket(),
      "/api/plans?repoId=shop-app": () => ({ status: 503, body: { error: "plans offline" } }),
    });
    render(<TicketPage repoId="shop-app" number={3349} />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByRole("alert").textContent).toMatch(
      /Could not load the signed-off plan/,
    );
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("explains a failed signed-off plan read on a QA report", async () => {
    serve({
      "/api/plans?repoId=mission-control": () => ({
        status: 503,
        body: { error: "plans offline" },
      }),
    });
    render(<QaReportRead report={qaReportFixture()} ticket="mission-control#2037" />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByRole("alert").textContent).toMatch(
      /Could not load the signed-off plan/,
    );
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("names a signed-off plan that is still loading on a QA report", async () => {
    serve({ "/api/plans?repoId=mission-control": () => new Promise(() => {}) });
    render(<QaReportRead report={qaReportFixture()} ticket="mission-control#2037" />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByRole("status").textContent).toMatch(/Loading the signed-off plan/);
  });
});
