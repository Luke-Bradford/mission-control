import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Header } from "../src/agent/Header.tsx";
import { Card } from "../src/board/Card.tsx";
import { doingLine, isCurrentWork, isSeatFree, seatStatus } from "../src/crew.ts";
import { hub } from "../src/data.ts";
import { PrChip } from "../src/hud/PrChip.tsx";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, NOW, prView, seatRow } from "./fixtures.ts";
import { REVIEW_STATES, REVIEWER } from "./reviewDisplayFixture.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubFetch({ "/api/config": CONFIG });
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(REVIEW_STATES)(
  "shows $label consistently on Board, PR chip and Agent title",
  ({ check, label }) => {
    const pr = prView({ check });
    const row = seatRow({
      hudState: "idle",
      review: { prNumber: pr.number, state: "open", check },
    });
    render(
      <>
        <Header row={row} limits={[]} />
        <div data-testid="chip">
          <PrChip pr={pr} />
        </div>
        <div data-testid="card">
          <Card
            item={boardItem({ status: "In review" })}
            showRepo={false}
            agent={null}
            step={null}
            queued={null}
            reviewer={null}
            pr={pr}
            checkPill={{ label, tone: "plain" }}
            mine={false}
            unacked={false}
            outcome="Closed"
            when=""
            statusOutOfDate={null}
            you={null}
          />
        </div>
      </>,
    );
    expect(within(screen.getByLabelText(`${row.id} details`)).getByText(label)).toBeTruthy();
    expect(within(screen.getByTestId("chip")).getByText(label)).toBeTruthy();
    expect(within(screen.getByTestId("card")).getByText(label)).toBeTruthy();
  },
);
it("keeps an assigned review current while it has no live CLI turn", () => {
  expect(seatStatus(REVIEWER).label).toBe("Checking");
  expect(isSeatFree(REVIEWER)).toBe(false);
  expect(isCurrentWork(REVIEWER)).toBe(true);
  expect(doingLine(REVIEWER, NOW, "UTC")).toBe(
    "RETRO-CX checking · 12 min · PR #1039 · shop-app#1027",
  );
  expect(seatStatus({ ...REVIEWER, reviewing: null }).label).toBe("Free");
  expect(
    seatStatus({ ...REVIEWER, crewPause: { seats: "all", by: "CAPCOM", reason: "Hold", at: NOW } })
      .label,
  ).toBe("Paused");
});

it("keeps a paused review's assignment visible without describing it as active checking", async () => {
  const paused = {
    ...REVIEWER,
    crewPause: { seats: "all" as const, by: "CAPCOM", reason: "Wait for CI", at: NOW },
  };
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [paused], firstRunToday: null },
    "/api/crew/status": { enabled: true },
    "/api/attention": [],
    "/api/limits": [],
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/repos/shop-app/prs?linked=1&shape=summary": [],
  });
  render(<AgentsPanel />);
  const row = (await screen.findByText("retro-cx")).closest('[role="row"]');
  expect(row?.textContent).toContain("Paused review PR #1039");
  expect(row?.textContent).toContain("Paused: Wait for CI");
  expect(row?.querySelector(".ticket-cell")?.textContent).not.toContain("Checking");
});
