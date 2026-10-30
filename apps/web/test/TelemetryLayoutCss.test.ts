import { describe, expect, it } from "vitest";
import { readStyles } from "./styles.ts";

const css = readStyles();
const rule = (selector: string) => css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Telemetry desktop chart workspace", () => {
  it("keeps chart panels in two bounded columns at the 1600px desktop layout", () => {
    const grid = rule(String.raw`\.tgrid`);
    expect(grid).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(grid).toContain("gap: var(--sp-3)");
    expect(rule(String.raw`\.chart`)).toContain("position: relative");
    expect(rule(String.raw`\.tgrid \.wide`)).toContain("grid-column: 1 / -1");
  });
});
