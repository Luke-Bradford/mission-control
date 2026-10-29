import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Header } from "../src/agent/Header.tsx";
import { Card } from "../src/board/Card.tsx";
import { MC_LINE_PREFIX } from "../src/flight/flightTypes.ts";
import { WorkingLog } from "../src/flight/WorkingLog.tsx";
import { ActivityPanel } from "../src/overview/ActivityPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, NOW, seatRow } from "./fixtures.ts";

afterEach(() => vi.restoreAllMocks());
const overflow = () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
};
it("expands the complete multiline wake text", async () => {
  overflow();
  const text = `${"Wake details ".repeat(30)}\nsecond line`;
  stubFetch({
    "/api/config": CONFIG,
    "/api/flight": { seat: { id: "flight" }, decisions: [] },
    "/api/agents/flight/stream": {
      events: [{ id: "a", kind: "op", at: 1, text: `${MC_LINE_PREFIX} ${text}` }],
    },
  });
  const { container } = render(<WorkingLog />);
  fireEvent.click(await screen.findByText("1 entry"));
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(container.querySelector(".txt .expandable-content")?.textContent).toBe(text);
});
it("shows three labels and the hidden count with the complete list", () => {
  const labels = ["one", "two", "three", "four", "five"];
  render(
    <Card
      item={boardItem({ labels })}
      showRepo={false}
      agent={null}
      step={null}
      queued={null}
      reviewer={null}
      pr={null}
      mine={false}
      unacked={false}
      outcome="Closed"
      when=""
      statusOutOfDate={null}
      you={null}
    />,
  );
  expect(screen.getByText("+2").title).toBe(labels.join(", "));
  expect(screen.queryByText("four")).toBeNull();
  for (const label of labels.slice(0, 3)) expect(screen.getByText(label).title).toBe(label);
});
it("gives every named shortened chip or value a title", () => {
  const cases = {
    "board/Card.tsx": "title={item.title}",
    "board/Toolbar.tsx": "title={lane.query}",
    "overview/QuotaPanel.tsx": "title={a}",
    "agent/Header.tsx": "title={row.role ?? undefined}",
    "agent/Tiles.tsx": "title={text}",
    "agent/StreamPanel.tsx": 'title={live ? live.name : "no tool running"}',
    "agent/LoopTimeline.tsx": "title={LOOP_PHASE_LABEL[step]}",
    "telemetry/CostGroup.tsx": "title={r.step}",
    "telemetry/FlowOfWork.tsx": 'title={r.size === NO_SIZE ? "no size" : r.size}',
    "components/TicketDetail.tsx": "title={name}",
  };
  for (const [file, title] of Object.entries(cases)) {
    expect(readFileSync(join(import.meta.dirname, `../src/${file}`), "utf8"), file).toContain(
      title,
    );
  }
});

it("expands Activity text and preserves its inline formatting", async () => {
  overflow();
  const text = `${"Activity detail ".repeat(40)}**final words**`;
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew": { rows: [] },
    "/api/activity": [
      {
        at: 1,
        who: "shop-app",
        kind: "run-start",
        text,
        ref: null,
        url: null,
        status: null,
        prs: [],
        summary: null,
      },
    ],
  });
  const { container } = render(<ActivityPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
  expect(container.querySelector(".expandable.open strong")?.textContent).toBe("final words");
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(container.querySelector(".expandable.open")).toBeNull();
});
it("bounds expanded prose and allows narrow HUD rows to shrink", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css).toMatch(
    /\.expandable \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/,
  );
  expect(css).toMatch(
    /\.expandable.open \.expandable-content \{[^}]*max-height: min\(50vh, 24rem\);[^}]*overflow: auto;/,
  );
  expect(css).toMatch(/#cHandled \.nrow > div \{[^}]*grid-column: 1 \/ -1;[^}]*min-width: 0;/);
});

it("renders titles on agent role, mode, session chips and tile values", async () => {
  stubFetch({ "/api/config": CONFIG });
  const row = seatRow({ role: "builder", mode: "writer", sessionId: "session-with-a-long-name" });
  const { container } = render(<Header row={row} limits={[]} now={NOW} />);
  const chips = container.querySelectorAll<HTMLElement>(".chips > span");
  expect(chips.length).toBeGreaterThanOrEqual(3);
  for (const chip of chips) expect(chip.title).toBe(chip.textContent);
  const values = container.querySelectorAll<HTMLElement>(".tile2 .v");
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) expect(value.title).toBe(value.textContent);
});
