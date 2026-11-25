import { cleanup, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { sortNeeds } from "../src/attention.ts";
import { needOwnerLabel } from "../src/crew.ts";
import { hub } from "../src/data.ts";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, item } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});
it("puts FLIGHT down before normally higher-priority asks without changing their order", () => {
  const source = [
    item({ key: "decision", kind: "decision" }),
    item({ key: "error", kind: "error" }),
    item({ key: "down", kind: "blocked", notTriaging: { cause: "down", keys: [], since: null } }),
    item({ key: "question", kind: "question" }),
  ];
  const normal = sortNeeds(source.filter((i) => !i.notTriaging));
  expect(sortNeeds(source).map((i) => i.key)).toEqual(["down", ...normal.map((i) => i.key)]);
  expect(source.map((i) => i.key)).toEqual(["decision", "error", "down", "question"]);
});
it("names the loop owner in Overview, with one reachable action for fifty asks", async () => {
  const row = crewRow({
    id: "studio",
    kind: "loop",
    hudState: "idle",
    run: null,
    ticket: null,
    loop: null,
  });
  const items = Array.from({ length: 50 }, (_, i) =>
    item({ key: `loop:${i}`, agentId: "studio", ticket: null, kind: "decision", owner: "loop" }),
  );
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [row] },
    "/api/attention": items,
    "/api/limits": [],
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/crew/status": { enabled: true },
  });
  const { container } = render(<AgentsPanel />);
  // The observed loop is a row of the Crew table; its need names the loop and the count.
  const need = await waitFor(() => {
    const el = container.querySelector<HTMLElement>("#agentsList .trow.needs .need");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  expect(need.textContent).toContain("Decision for studio · 50 items");
  expect(need.textContent).not.toContain("needs you");
  expect(within(need).getAllByRole("button")).toHaveLength(1);
  // No Answer anywhere on the loop's row, not just in its need cell.
  expect(
    within(need.closest(".trow") as HTMLElement).queryByRole("button", { name: "Answer" }),
  ).toBeNull();
  expect(needOwnerLabel(row, items)).toBe("has an item to resolve");
});
