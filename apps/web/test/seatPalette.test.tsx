import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNavRow } from "../src/comms/CommsNav.tsx";
import { hub } from "../src/data.ts";
import { AgentTag } from "../src/hud/AgentTag.tsx";
import { CrewLane } from "../src/overview/CrewLane.tsx";
import { crewRow } from "./fixtures.ts";
import { observedContextDigest } from "./overviewDensityFixtures.ts";

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
const NOW = Date.UTC(2026, 10, 4, 12, 30);
const row = crewRow({
  id: "GUIDO-1",
  index: SEAT_INDEX,
  digest: observedContextDigest(null, null, [[NOW - 60_000, 100]]),
});

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.unstubAllGlobals();
});

describe("a seat is one colour on every page", () => {
  it("renders the same hex on Overview, Agent and Comms", () => {
    // Overview: the agent's activity lane
    const overview = render(
      <CrewLane row={row} name="GUIDO-1" lane={undefined} now={NOW} max={10} />,
    );
    const trace = overview.container.querySelector(".crew-lane-bar")?.getAttribute("fill");
    overview.unmount();
    // Agent: the seat's tag
    const agent = render(<AgentTag id="GUIDO-1" index={SEAT_INDEX} />);
    const tag = (agent.container.firstElementChild as HTMLElement).style.getPropertyValue("--c");
    agent.unmount();
    // Comms: the seat's row in the navigator
    const comms = render(<AgentNavRow row={row} view={{ kind: "crew" }} onNavigate={() => {}} />);
    const nav = comms.container.querySelector<HTMLElement>("i")?.style.background;
    comms.unmount();
    const hexes = [trace, tag, nav].map(resolve);
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
