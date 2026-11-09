import { describe, expect, it } from "vitest";
import { chartHref, commsHrefFor, filterPath } from "../src/comms/chartPaths.ts";
import { pairFilter } from "../src/comms/commsFilter.ts";
import { commsAgentPath, commsContactPath, commsCrewPath, commsFlightPath } from "../src/router.ts";

const FLIGHT = "flight-1";

describe("the conversation a chart filter opens in Comms", () => {
  it.each([
    ["CAPCOM", commsFlightPath()],
    [FLIGHT, commsFlightPath()],
    ["crew", commsCrewPath()],
    ["dev-1", commsAgentPath("dev-1")],
  ])("a seat filter on %s opens %s", (id, path) => {
    expect(filterPath({ kind: "seat", id }, FLIGHT)).toBe(path);
  });

  it.each([
    ["CAPCOM", FLIGHT, commsFlightPath()],
    ["crew", "dev-1", commsCrewPath()],
    ["CAPCOM", "crew", commsCrewPath()],
    ["CAPCOM", "dev-1", commsContactPath("dev-1", "CAPCOM")],
    ["dev-1", "dev-2", commsContactPath("dev-1", "dev-2")],
  ])("a pair filter on %s and %s opens %s", (a, b, path) => {
    expect(filterPath(pairFilter(a, b), FLIGHT)).toBe(path);
  });

  it("keeps the chart narrowed on the way to Comms and back out to the pop-out", () => {
    const seat = { kind: "seat", id: "dev-1" } as const;
    expect(commsHrefFor(seat, FLIGHT)).toBe(`${commsAgentPath("dev-1")}?focus=seat%3Adev-1`);
    expect(chartHref(seat)).toBe("/comms/chart?focus=seat%3Adev-1");
    expect(chartHref(null)).toBe("/comms/chart");
  });
});
