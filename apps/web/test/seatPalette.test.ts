import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentColor } from "../src/hud/AgentTag.tsx";
import { seatToken } from "../src/map/cards.ts";

const SRC = join(__dirname, "../src");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith(".css") ? [p] : [];
  });
}

describe("one seat palette", () => {
  it("gives a seat the same token on Overview, Agent, Comms (agentColor) and Map (seatToken)", () => {
    for (let i = 0; i < 20; i++) {
      expect(agentColor(i)).toBe(`var(${seatToken("any", i)})`);
    }
  });

  it("defines --seat-1…7 only in hud.css", () => {
    const defining = cssFiles(SRC).filter((f) =>
      /^\s*--seat-[1-7]:/m.test(readFileSync(f, "utf8")),
    );
    expect(defining.map((f) => f.slice(SRC.length + 1))).toEqual(["hud.css"]);
  });

  it("gives each seat one hex in every theme", () => {
    const css = readFileSync(join(SRC, "hud.css"), "utf8");
    const byToken = new Map<string, Set<string>>();
    for (const [, n, hex] of css.matchAll(/--seat-([1-7]):\s*(#[0-9a-f]{6})/gi)) {
      byToken.set(`${n}`, (byToken.get(`${n}`) ?? new Set()).add(hex.toLowerCase()));
    }
    expect(byToken.size).toBe(7);
    for (const hexes of byToken.values()) expect(hexes.size).toBe(1);
  });
});
