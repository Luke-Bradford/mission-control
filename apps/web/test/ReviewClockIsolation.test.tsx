import { needsYouItems, type ReviewCheckState } from "@mc/core";
import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HeaderReviewState } from "../src/agent/Header.tsx";
import { Card, cardRenderProbe } from "../src/board/Card.tsx";
import { Kanban } from "../src/board/Kanban.tsx";
import { PrChip } from "../src/hud/PrChip.tsx";
import { reviewStateProps } from "../src/hud/ReviewState.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, NOW, prView } from "./fixtures.ts";

afterEach(() => {
  cardRenderProbe.onRender = null;
  vi.useRealTimers();
});

it.each([
  null,
  { kind: "queued", position: 2 },
  { kind: "sent" },
  { kind: "ready" },
  { kind: "held", by: "CAPCOM", reason: "Wait for evidence" },
] as (ReviewCheckState | null)[])(
  "does not tick a PR chip with static review state %j",
  async (check) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const fetch = stubFetch({ "/api/config": CONFIG });
    let commits = 0;
    render(
      <Profiler id="chip" onRender={() => commits++}>
        <PrChip pr={prView({ check })} />
      </Profiler>,
    );
    await screen.findByRole("link", { name: "shop-app PR #77" });
    await settled(fetch, "/api/config");
    commits = 0;
    const reads = fetch.mock.calls.length;
    act(() => vi.advanceTimersByTime(65_000));
    expect(commits).toBe(0);
    expect(fetch.mock.calls.length).toBe(reads);
  },
);

it("updates only elapsed review children while the Board card and header controls stay stable", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  const fetch = stubFetch({ "/api/config": CONFIG });
  const check = { kind: "checking" as const, seat: "retro-1", since: NOW - 60_000 };
  const status = reviewStateProps(check);
  const pr = prView({ check });
  const view = render(
    <>
      <HeaderReviewState check={check} />
      <PrChip pr={pr} />
      <Card
        item={boardItem({ status: "In review" })}
        showRepo={false}
        agent={null}
        step={null}
        queued={null}
        reviewer={null}
        pr={pr}
        checkLabel={status.label}
        checkTone={status.tone}
        checkingSeat={status.checkingSeat}
        checkingSince={status.checkingSince}
        mine={false}
        unacked={false}
        outcome="Closed"
        when=""
        statusOutOfDate={null}
        you={null}
      />
    </>,
  );
  await screen.findAllByText("RETRO-1 checking · 1 min");
  const card = view.container.querySelector(".kcard");
  const renders: string[] = [];
  cardRenderProbe.onRender = (ref) => renders.push(ref);
  const reads = fetch.mock.calls.length;
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getAllByText("RETRO-1 checking · 2 min")).toHaveLength(3);
  expect(view.container.querySelector(".kcard")).toBe(card);
  expect(renders).toEqual([]);
  expect(fetch.mock.calls.length).toBe(reads);
});

it("keeps checking cards unchanged when Kanban receives a later clock value", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  const fetch = stubFetch({ "/api/config": CONFIG });
  const items = [boardItem({ issueNumber: 77, status: "In review" })];
  const prs = [prView({ check: { kind: "checking", seat: "retro-1", since: NOW - 60_000 } })];
  const props = {
    items,
    prs,
    showRepo: false,
    crew: [],
    needsYou: needsYouItems([]),
    tz: "UTC",
    todayStart: NOW - 12 * 60 * 60_000,
  };
  const view = render(<Kanban {...props} now={NOW} />);
  await settled(fetch, "/api/config");
  expect(screen.getByText("RETRO-1 checking · 1 min")).toBeTruthy();
  const renders: string[] = [];
  cardRenderProbe.onRender = (ref) => renders.push(ref);
  const reads = fetch.mock.calls.length;
  act(() => vi.advanceTimersByTime(60_000));
  view.rerender(<Kanban {...props} now={NOW + 60_000} />);
  expect(screen.getByText("RETRO-1 checking · 2 min")).toBeTruthy();
  expect(renders).toEqual([]);
  expect(fetch.mock.calls.length).toBe(reads);
});
