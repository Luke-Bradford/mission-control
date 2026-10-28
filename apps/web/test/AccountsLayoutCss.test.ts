import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";

const width = (selector: string) => Number(rule(selector).match(/width: (\d+)%/)?.[1]);

describe("Setup Accounts usage layout (hud.css)", () => {
  it.each([1280, 1920])("keeps usage bars inside their cells at %ipx", (viewport) => {
    const dockedMain = viewport - 2 * 14 - 14 - 380;
    const table = dockedMain - 2 - 2 * 14;
    const quotaCell = (table * width(String.raw`\.accounts-table th:nth-child\(5\)`)) / 100 - 2 * 8;

    expect(quotaCell).toBeGreaterThan(0);
    expect(rule(String.raw`\.account-quota`)).toContain("overflow: hidden");
    expect(rule(String.raw`\.account-quota \.meter`)).toContain("max-width: 100%");
    expect(rule(String.raw`\.account-quota \.meter`)).toContain("min-width: 0");
    expect(rule(String.raw`\.account-quota \.meter \.track`)).toContain("min-width: 0");
    expect(rule(String.raw`\.account-quota \.meter \.track`)).toContain("max-width: 100%");
  });

  it("truncates a forecast to its cell while preserving its full value in a tooltip", () => {
    expect(rule(String.raw`\.quota-forecast`)).toContain("overflow: hidden");
    expect(rule(String.raw`\.quota-forecast`)).toContain("text-overflow: ellipsis");
    expect(rule(String.raw`\.quota-forecast`)).toContain("white-space: nowrap");
  });
});
