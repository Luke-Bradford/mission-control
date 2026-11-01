import { firstLoadPaths } from "@mc/core";
import { describe, expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";

const ctx = {
  repoIds: ["site-builder", "mission-control"],
  seatIds: ["alpha", "studio"],
  flightId: "flight-1",
  agentId: "alpha",
};

/** The reads the web makes for each page, built from its resource refs. */
const requested: Record<string, string[]> = {
  Overview: [
    RESOURCES.crew.path,
    ...ctx.repoIds.map((r) => RESOURCES.allPrs(r).path),
    RESOURCES.stream(ctx.flightId).path,
  ],
  Comms: [
    ...ctx.seatIds.map((s) => RESOURCES.commsNav(s).path),
    RESOURCES.commsAgent(ctx.agentId).path,
    RESOURCES.commsCrew.path,
    RESOURCES.commsFlight.path,
    RESOURCES.crew.path,
  ],
  Board: [
    ...ctx.repoIds.map((r) => RESOURCES.prs(r).path),
    RESOURCES.crew.path,
    RESOURCES.boards("site-builder").path,
  ],
  Agent: [
    RESOURCES.allPrs("site-builder").path,
    RESOURCES.runs(ctx.agentId).path,
    RESOURCES.stream(ctx.agentId).path,
    RESOURCES.crewDetail(ctx.agentId).path,
  ],
};

describe("first-load routes", () => {
  for (const [page, paths] of Object.entries(requested)) {
    it(`${page} asks for the routes the response budget measures`, () => {
      const budget = firstLoadPaths(page, ctx);
      for (const p of paths) {
        if (p.startsWith("/api/agents/alpha/runs")) continue; // the runs page size is its own
        expect(budget).toContain(p);
      }
    });
  }
});
