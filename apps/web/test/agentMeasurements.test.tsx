import { type AgentStream, type LoopTry, RETRY_NOTE, type RunLoopView } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoopSteps } from "../src/agent/LoopSteps.tsx";
import { LoopTimeline } from "../src/agent/LoopTimeline.tsx";
import { stepTokens } from "../src/agent/loopView.ts";
import { SideTabs } from "../src/agent/SideTabs.tsx";
import { Tiles } from "../src/agent/Tiles.tsx";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow, MIN, NOW, run } from "./fixtures.ts";

const row = crewRow({ loop: { phase: "working", text: "Editing", prNumber: null, parked: null } });
const attempt = (tokens: number | null | undefined, n: number): LoopTry => ({
  step: "working",
  fix: false,
  n,
  tokens,
  startedAt: NOW - 2 * MIN,
  endedAt: NOW - MIN,
  outcome: "pass",
  reason: null,
});

it("sums measured retries once and shows each attempt and timeline tokens, including zero and missing", () => {
  const tries = [
    attempt(1200, 1),
    attempt(300, 2),
    attempt(0, 3),
    attempt(null, 4),
    attempt(undefined, 5),
  ];
  const view = { loop: { phase: "working" }, tries } as RunLoopView;
  const { container } = render(
    <LoopSteps row={row} view={view} prs={[]} limits={{ tries: 3, rounds: 3 }} now={NOW} />,
  );
  expect(container.querySelector(".vmeta")?.textContent).toBe("1.5k · 5m");
  expect([...container.querySelectorAll(".att")].map((e) => e.textContent)).toEqual([
    "try 1pass1.2k1m",
    "try 2pass3001m",
    "try 3pass01m",
    "try 4pass—1m",
    "try 5pass—1m",
  ]);
  expect(container.textContent).toContain(RETRY_NOTE);
  const header = container.querySelector<HTMLButtonElement>("button.vhead") as HTMLButtonElement;
  expect(header.tabIndex).toBe(0);
  fireEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(header);
  expect(container.querySelectorAll(".att")).toHaveLength(5);
  expect(stepTokens([attempt(null, 1), attempt(undefined, 2)])).toBeNull();
  expect(stepTokens([attempt(0, 1)])).toBe(0);
  const timeline = render(
    <LoopTimeline row={row} loopView={{ data: view, error: null, loading: false }} now={NOW} />,
  );
  expect(
    [...timeline.container.querySelectorAll("i[title]")].map((e) => e.getAttribute("title")),
  ).toEqual([
    "Working try 1 · pass · 1.2k tokens · 1 min",
    "Working try 2 · pass · 300 tokens · 1 min",
    "Working try 3 · pass · 0 tokens · 1 min",
    "Working try 4 · pass · — tokens · 1 min",
    "Working try 5 · pass · — tokens · 1 min",
  ]);
});

describe("live Plan", () => {
  it.each(["loading", "failed", "another run", "no run"])(
    "keeps the Plan count unknown for %s",
    async (state) => {
      const streamPath = `/api/agents/${row.id}/stream`;
      const fetch = stubFetch({
        [streamPath]: () => ({
          status: state === "failed" ? 503 : 200,
          body:
            state === "failed"
              ? { error: "Stream unavailable" }
              : { runId: "older-run", tasks: [], events: [] },
        }),
        [`/api/agents/${row.id}/files`]: { files: [], note: null },
      });
      if (state === "loading") {
        fetch.mockImplementation(() => new Promise<Response>(() => {}));
      }
      render(<SideTabs row={state === "no run" ? { ...row, run: null } : row} />);
      if (state === "failed") await screen.findByText(/Could not load the task list:/);
      if (state === "another run") await screen.findByText("No task list yet.");
      expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    },
  );

  it.each([false, true])(
    "marks a cached task list as last known after refresh fails (empty: %s)",
    async (empty) => {
      let failed = false;
      stubFetch({
        [`/api/agents/${row.id}/stream`]: () => ({
          status: failed ? 503 : 200,
          body: failed
            ? { error: "Stream unavailable" }
            : {
                runId: row.run?.id,
                tasks: empty ? [] : [{ id: "1", text: "Cached task", status: "done" }],
                events: [],
              },
        }),
        [`/api/agents/${row.id}/files`]: { files: [], note: null },
      });
      render(<SideTabs row={row} />);
      await screen.findByRole("button", { name: empty ? "Plan 0/0" : "Plan 1/1" });
      failed = true;
      act(() => hub.refetch(`/api/agents/${row.id}/stream`));
      expect(
        await screen.findByText("Could not refresh the task list: Stream unavailable"),
      ).toBeTruthy();
      expect(screen.getByText(/Last known task list/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
      expect(screen.getByText(empty ? "No task list yet." : "Cached task")).toBeTruthy();
    },
  );

  it("replays status changes and clears tasks when runs or agents change", async () => {
    let stream: AgentStream = {
      runId: row.run?.id ?? null,
      tasks: [
        { id: "1", text: "Check widgets", status: "in_progress" },
        { id: "2", text: "Test widgets", status: "pending" },
      ],
      events: [],
      truncated: false,
      lastOutputAt: null,
      reason: null,
    };
    stubFetch({
      [`/api/agents/${row.id}/stream`]: () => ({ status: 200, body: stream }),
      [`/api/agents/${row.id}/files`]: { files: [], note: null },
      "/api/agents/other/stream": { ...stream, runId: "other-run", tasks: [] },
      "/api/agents/other/files": { files: [], note: null },
    });
    const page = render(<SideTabs row={row} />);
    await screen.findByRole("button", { name: "Plan 0/2" });
    expect(page.container.textContent).toContain("◌ doingCheck widgets");
    expect(page.container.textContent).toContain("· to doTest widgets");
    expect(page.container.querySelector(".note")?.textContent).toBe(
      "The agent's own task list: Claude's task tools or Codex plan updates, replayed from its stream.",
    );
    stream = { ...stream, tasks: stream.tasks?.map((t) => ({ ...t, status: "done" })) };
    act(() => hub.refetch(`/api/agents/${row.id}/stream`));
    await screen.findByRole("button", { name: "Plan 2/2" });
    expect(page.container.textContent).toContain("✓ doneCheck widgets");
    page.rerender(<SideTabs row={{ ...row, run: { ...run(), id: "new-run" } }} />);
    expect(screen.getByText("No task list yet.")).toBeTruthy();
    expect(screen.queryByText("Check widgets")).toBeNull();
    page.rerender(<SideTabs row={{ ...row, id: "other", run: { ...run(), id: "other-run" } }} />);
    await screen.findByRole("button", { name: "Plan 0/0" });
    expect(screen.queryByText("Check widgets")).toBeNull();
  });

  it("shows loading, failure and empty responses", async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        path.endsWith("/stream")
          ? new Promise<Response>((r) => {
              resolve = r;
            })
          : Promise.resolve(new Response(JSON.stringify({ files: [], note: null }))),
      ),
    );
    const page = render(<SideTabs row={row} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () =>
      resolve(new Response(JSON.stringify({ error: "Stream unavailable" }), { status: 503 })),
    );
    expect(await screen.findByText(/Could not load the task list:/)).toBeTruthy();
    page.rerender(<SideTabs row={{ ...row, run: null }} />);
    expect(screen.getByText("No task list yet.")).toBeTruthy();
  });
});

it("shows distinct per-file commits and dirty labels while keeping diff buttons keyboard accessible", async () => {
  stubFetch({
    [`/api/agents/${row.id}/stream`]: { runId: null, tasks: [], events: [] },
    [`/api/agents/${row.id}/files`]: {
      files: [
        { path: "a.ts", add: 0, del: 0, state: "committed", commitSha: "abc123456789" },
        { path: "b.ts", add: 2, del: 1, state: "committed", commitSha: "def456789012" },
        { path: "c.ts", add: null, del: null, state: "untracked", commitSha: null },
      ],
      note: null,
    },
    [`/api/agents/${row.id}/files/diff?path=a.ts`]: {
      text: "@@ a.ts @@",
      binary: false,
      truncated: false,
    },
  });
  render(<SideTabs row={row} />);
  fireEvent.click(await screen.findByRole("button", { name: "Files 3" }));
  const file = screen.getByRole("button", { name: "a.ts+0 −0abc1234" });
  expect(file.tabIndex).toBe(0);
  file.focus();
  expect(document.activeElement).toBe(file);
  expect(fireEvent.keyDown(file, { key: "Enter" })).toBe(true);
  fireEvent.click(file);
  expect(await screen.findByText("@@ a.ts @@")).toBeTruthy();
  expect(screen.getByRole("button", { name: "b.ts+2 −1def4567" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "c.ts—uncommitted" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("region")).getByRole("button", { name: "Close" }));
  expect(screen.queryByText("@@ a.ts @@")).toBeNull();
});

it("shows measured zero timing and speed instead of unavailable dashes", () => {
  const { container } = render(
    <Tiles
      row={{
        ...row,
        digest: {
          toolCalls: 0,
          turns: 0,
          lastEventAt: null,
          model: null,
          contextTokens: null,
          contextWindow: null,
          liveTool: null,
          tools: {},
          subagents: [],
          minuteTokens: [],
          turnUsage: [],
          background: [],
          compactions: 0,
          speed: { tokensPerSec: 0, firstTokenMs: 0, turnMs: 0 },
        },
      }}
      limits={[]}
      now={NOW}
    />,
  );
  const speed = [...container.querySelectorAll(".tile2")].find(
    (tile) => tile.querySelector(".lbl")?.textContent === "Speed",
  ) as HTMLElement;
  expect(speed.querySelector(".v")?.textContent).toBe("0tokens/s");
  expect(speed.querySelector(".d")?.textContent).toBe("first token <0.1s · turn <0.1s");
});
