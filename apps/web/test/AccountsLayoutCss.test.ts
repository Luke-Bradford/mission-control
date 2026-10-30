import { describe, expect, it } from "vitest";
import { readStyles } from "./styles.ts";

const css = readStyles();
const rule = (selector: string) => css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Setup Accounts usage layout (hud.css)", () => {
  it("keeps the top-bar clock's line box fixed between ticks", () => {
    const clock = rule(String.raw`\.top-clock`);

    expect(clock).toContain("line-height: var(--lh-micro)");
    expect(clock).toContain("height: 16px");
  });

  it("truncates a forecast to its cell while preserving its full value in a tooltip", () => {
    expect(rule(String.raw`\.quota-forecast`)).toContain("overflow: hidden");
    expect(rule(String.raw`\.quota-forecast`)).toContain("text-overflow: ellipsis");
    expect(rule(String.raw`\.quota-forecast`)).toContain("white-space: nowrap");
  });
});
