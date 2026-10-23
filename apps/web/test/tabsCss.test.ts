import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");

describe("page tabs (hud.css)", () => {
  it("wrap at phone width instead of scrolling sideways", () => {
    const blocks = css
      .split("media (max-width: 760px) {")
      .slice(1)
      .map((b) => b.split("\n}")[0] ?? "");
    const r =
      blocks.map((b) => b.match(/\n {2}\.tabs \{([^}]*)\}/)?.[1]).find((x) => x !== undefined) ??
      "";
    expect(r).toContain("flex-wrap: wrap;");
    expect(r).toContain("overflow-x: visible;");
  });
});
