import type { QaPlan, TicketHistory } from "@mc/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TicketPage } from "../src/pages/TicketPage.tsx";
import { QaReportRead } from "../src/qa/QaReport.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";
import { qaReportFixture } from "./qaReportFixture.ts";

const HASH = "a".repeat(64);
const signedPlan: QaPlan = {
  ref: "shop-app#3349",
  asks: "Quotes are slow.",
  proposal: "Cache the quote total.",
  sizeEstimate: "M",
  risks: "Stale totals.",
  mockups: [
    { id: HASH, caption: "Quote mockup", mediaType: "image/png", url: `/api/plan-assets/${HASH}` },
  ],
  decidedAt: 10,
};
const ticket = (): TicketHistory => ({
  repoId: "shop-app",
  number: 3349,
  url: "https://example.test/3349",
  title: "Quote cache",
  state: "open",
  status: "In progress",
  priority: "p1",
  size: "M",
  labels: [],
  outcome: null,
  doneWhen: [],
  body: null,
  bodyTruncated: false,
  githubError: null,
  plan: {
    ...signedPlan,
    state: "signed-off",
    marked: true,
    repoId: "shop-app",
    issue: 3349,
    title: "Quote cache",
    note: null,
    requestedAt: 1,
    plannedAt: 2,
  },
  runs: [],
  prs: [],
  timeline: [],
  nextBefore: null,
});

describe("the signed-off plan beside what was built", () => {
  it("uses the ticket's retained signed-off plan", async () => {
    stubFetch({ "/api/config": CONFIG, "/api/tickets/shop-app/3349": ticket() });
    render(<TicketPage repoId="shop-app" number={3349} />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByText("Cache the quote total.")).toBeTruthy();
  });
  it("uses the QA report's retained plan", async () => {
    const report = { ...qaReportFixture(), plan: signedPlan };
    render(<QaReportRead report={report} />);
    const panel = await screen.findByRole("region", { name: "Signed-off plan" });
    expect(within(panel).getByText("Cache the quote total.")).toBeTruthy();
  });
});
