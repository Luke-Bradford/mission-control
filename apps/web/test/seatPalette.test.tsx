import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mapSnapshotFixture } from "@mc/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNavRow } from "../src/comms/CommsNav.tsx";
import { hub } from "../src/data.ts";
import { AgentTag } from "../src/hud/AgentTag.tsx";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { AgentActivity } from "../src/overview/AgentActivity.tsx";
import { crewRow } from "./fixtures.ts";

const SRC = join(__dirname, "../src");
const hudCss = readFileSync(join(SRC, "hud.css"), "utf8");

/** The hex a `var(--seat-n)` resolves to in hud.css's first (default) theme block. */
function resolve(token: string | null | undefined): string {
  const name = /var\((--seat-\d)\)/.exec(token ?? "")?.[1];
  if (!name) throw new Error(`not a seat token: ${token}`);
  const hex = new RegExp(`${name}: (#[0-9a-f]{6})`, "i").exec(hudCss)?.[1];
  if (!hex) throw new Error(`${name} is not defined in hud.css`);
  return hex.toLowerCase();
}

const SEAT_INDEX = 3;
const row = crewRow({ id: "GUIDO-1", index: SEAT_INDEX });

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});

describe("a seat is one colour on every page", () => {
  it("renders the same hex on Overview, Agent, Comms and Map", () => {
    // Overview: the agent's activity trace
    const overview = render(<AgentActivity row={row} now={Date.now()} max={10} />);
    const trace = overview.container.querySelector("stop")?.getAttribute("stop-color");
    overview.unmount();
    // Agent: the seat's tag
    const agent = render(<AgentTag id="GUIDO-1" index={SEAT_INDEX} />);
    const tag = (agent.container.firstElementChild as HTMLElement).style.getPropertyValue("--c");
    agent.unmount();
    // Comms: the seat's row in the navigator
    const comms = render(
      <AgentNavRow row={row} view={{ kind: "crew" }} mentions={0} onNavigate={() => {}} />,
    );
    const nav = comms.container.querySelector<HTMLElement>("i")?.style.background;
    comms.unmount();
    // Map: the seat's light in the selector
    const snapshot = structuredClone(mapSnapshotFixture);
    snapshot.seats = [
      {
        ...structuredClone(mapSnapshotFixture.seats[0]),
        seat: "GUIDO-1",
        state: "running",
      },
    ];
    render(
      <CrewMapView snapshot={snapshot} indices={{ "GUIDO-1": SEAT_INDEX }} names={{}} work={{}} />,
    );
    const list = screen.getByRole("list", { name: "Seats working in this repo" });
    const light = within(list)
      .getAllByRole("button")[0]
      ?.querySelector<HTMLElement>(".map-light")
      ?.style.getPropertyValue("--light");

    const hexes = [trace, tag, nav, light].map(resolve);
    expect(new Set(hexes).size).toBe(1);
  });

  it("defines seat tokens only in hud.css", () => {
    const cssFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return cssFiles(p);
        return p.endsWith(".css") ? [p] : [];
      });
    const defining = cssFiles(SRC).filter((f) => /^\s*--seat-\d+:/m.test(readFileSync(f, "utf8")));
    expect(defining.map((f) => f.slice(SRC.length + 1))).toEqual(["hud.css"]);
  });

  it("keeps each seat's hex stable across themes", () => {
    const byToken = new Map<string, Set<string>>();
    for (const [, n, hex] of hudCss.matchAll(/--seat-(\d+):\s*(#[0-9a-f]{6})/gi)) {
      byToken.set(`${n}`, (byToken.get(`${n}`) ?? new Set()).add((hex ?? "").toLowerCase()));
    }
    expect(byToken.size).toBeGreaterThan(0);
    for (const hexes of byToken.values()) expect(hexes.size).toBe(1);
  });
});
