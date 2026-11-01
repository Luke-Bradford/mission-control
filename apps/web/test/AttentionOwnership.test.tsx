import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NeedBanner } from "../src/agent/NeedBanner.tsx";
import { hub } from "../src/data.ts";
import { AgentsPanel } from "../src/overview/AgentsPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, item } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});
it("names the loop owner in Overview and Agent, with one reachable action for fifty asks", async () => {
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
  const { container } = render(
    <>
      <AgentsPanel />
      <NeedBanner row={row} items={items} />
    </>,
  );
  const loops = await screen.findByRole("navigation", { name: "Loops" });
  expect(loops.textContent).toContain("has an item to resolve");
  expect(loops.textContent).not.toContain("needs you");
  const banner = container.querySelector("#needBanner");
  expect(banner?.textContent).toContain("studio has an item to resolve.");
  expect(banner?.textContent).toContain("50 items");
  expect(banner?.querySelectorAll("button")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
});
