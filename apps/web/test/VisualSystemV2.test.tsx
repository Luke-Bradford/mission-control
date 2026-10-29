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

function deltaE(a: string, b: string): number {
  const lab = (hex: string): [number, number, number] => {
    const linear = [1, 3, 5].map((i) => {
      const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const [r, g, b] = linear;
    const xyz = [
      (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505,
      0.2126 * r + 0.7152 * g + 0.0722 * b,
      (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089,
    ].map((value) => (value > 0.008_856 ? Math.cbrt(value) : 7.787 * value + 16 / 116));
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
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
      for (const [index, agent] of agents.entries()) {
        for (const other of agents.slice(index + 1))
          expect(deltaE(agent, other), `${agent} / ${other}`).toBeGreaterThanOrEqual(20);
        for (const state of [theme["--ok"], theme["--warn"], theme["--crit"]])
          expect(deltaE(agent, state), `${agent} / ${state}`).toBeGreaterThanOrEqual(20);
      }
      for (const [index, agent] of agents.entries())
        expect(
          contrast(agent, theme["--surface"]),
          AGENT_TOKEN_NAMES[index],
        ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["dark", "light"] as const)(
    "keeps chart slots s2 and s5 perceptually distinct: %s",
    (theme) => {
      expect(
        deltaE(THEME_TOKENS[theme]["--s2"], THEME_TOKENS[theme]["--s5"]),
      ).toBeGreaterThanOrEqual(25);
    },
  );

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

  it("uses only the six shared type tokens for HUD font sizes", () => {
    const declarations = css.matchAll(/(?:font-size|font):\s*([^;]+);/g);
    for (const declaration of declarations) {
      const value = declaration[1] ?? "";
      if (value.includes("inherit")) continue;
      expect(value).toMatch(/var\(--type-(?:xs|sm|base|md|lg|xl)\)/);
      expect(value).not.toMatch(/\d+(?:\.\d+)?(?:px|em|rem)|clamp\(/);
    }
  });
});
