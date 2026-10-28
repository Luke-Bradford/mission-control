import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { agentColor } from "../src/hud/AgentTag.tsx";
import { AGENT_TOKEN_NAMES, THEME_TOKENS } from "../src/theme.ts";

const css = readFileSync(resolve(process.cwd(), "apps/web/src/hud.css"), "utf8");

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/\w\w/g)?.map((part) => Number.parseInt(part, 16) / 255);
    if (!channels) throw new Error(`Expected a hex colour: ${hex}`);
    const [r, g, blue] = channels.map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("visual system v2", () => {
  it("assigns all eight crew slots a distinct non-semantic colour", () => {
    expect(new Set(Array.from({ length: 8 }, (_, index) => agentColor(index)))).toEqual(
      new Set(AGENT_TOKEN_NAMES.map((token) => `var(${token})`)),
    );
    for (const theme of Object.values(THEME_TOKENS)) {
      const agents = AGENT_TOKEN_NAMES.map((token) => theme[token]);
      expect(new Set(agents)).toHaveLength(8);
      expect(agents).not.toContain(theme["--ok"]);
      expect(agents).not.toContain(theme["--warn"]);
      expect(agents).not.toContain(theme["--crit"]);
      for (const [index, agent] of agents.entries())
        expect(
          contrast(agent, theme["--surface"]),
          AGENT_TOKEN_NAMES[index],
        ).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses the shared borderless stat bar and unbounded Overview panel bodies", () => {
    expect(css).toMatch(/--type-(?:xs|sm|base|md|lg|xl):/);
    expect(css).toMatch(/\.overview-kpis\s*\{[^}]*border-block:/s);
    expect(css).toMatch(/\.overview-kpi\s*\{[^}]*border:\s*0/s);
    expect(css).toMatch(/#page-overview\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.ov\s*>\s*\.col\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.ov\s*>\s*\.col\s*>\s*\.panel\s*>\s*\.pb\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/select\s*\{[^}]*appearance:/s);
    expect(css).toMatch(/input\[type="radio"\]\s*\{[^}]*accent-color:/s);
  });
});
