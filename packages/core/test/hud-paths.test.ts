import { expect, it } from "vitest";
import { FIRST_LOAD_PAGES, firstLoadPaths } from "../src/index.ts";

const ctx = {
  repoIds: ["mission-control", "shop app"],
  seatIds: ["guido-1", "inco-1"],
  flightId: "flight-1",
  agentId: "guido-1",
};

it("the first-load paths use the summary, paged and detail forms", () => {
  expect(firstLoadPaths("Overview", ctx)).toEqual([
    "/api/crew?shape=summary",
    "/api/repos/mission-control/prs?shape=summary",
    "/api/repos/shop%20app/prs?shape=summary",
    "/api/agents/flight-1/stream?limit=20",
    "/api/flight",
    "/api/activity",
    "/api/overview",
  ]);
  expect(firstLoadPaths("Comms", ctx)).toEqual([
    "/api/comms/agents/guido-1?summary=1",
    "/api/comms/agents/inco-1?summary=1",
    "/api/comms/agents/guido-1",
    "/api/comms/crew",
    "/api/comms/flight",
    "/api/crew?shape=summary",
  ]);
  expect(firstLoadPaths("Board", ctx)[0]).toBe(
    "/api/repos/mission-control/prs?linked=1&shape=summary",
  );
  expect(firstLoadPaths("Agent", ctx)).toContain("/api/crew/guido-1");
  for (const page of FIRST_LOAD_PAGES) expect(firstLoadPaths(page, ctx).length).toBeGreaterThan(0);
  expect(() => firstLoadPaths("Nope", ctx)).toThrow();
});
