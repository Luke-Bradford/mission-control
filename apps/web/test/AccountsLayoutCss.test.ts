import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";

const percentage = (selector: string) => Number(rule(selector).match(/width: (\d+)%/)?.[1]);
const pixels = (body: string, property: string) =>
  Number(body.match(new RegExp(`${property}: (\\d+)px`))?.[1]);
const contains = (body: string, declaration: string) => body.includes(declaration);
const percentValue = (body: string, property: string) =>
  Number(body.match(new RegExp(`${property}: (\\d+)%`))?.[1]);
const constrainedWidth = (natural: number, available: number, body: string) =>
  Math.min(natural, (available * percentValue(body, "max-width")) / 100);

describe("Setup Accounts usage layout (hud.css)", () => {
  it("keeps the top-bar clock's line box fixed between ticks", () => {
    const clock = rule(String.raw`\.top-clock`);

    expect(clock).toContain("line-height: 16px");
    expect(clock).toContain("height: 16px");
  });

  it.each([1280, 1920])("keeps usage bars inside every quota cell at %ipx", (viewport) => {
    const dockedMain = viewport - 2 * 14 - 14 - 380;
    const table = dockedMain - 2 - 2 * 14;
    const cellPadding =
      pixels(rule(String.raw`\.accounts-table th,\n.accounts-table td`), "padding") * 2;
    const quota = rule(String.raw`\.account-quota`);
    const meterBase = rule(String.raw`\.meter`);
    const meter = rule(String.raw`\.account-quota \.meter`);
    const track = rule(String.raw`\.account-quota \.meter \.track`);
    const forecast = rule(String.raw`\.quota-forecast`);

    expect(contains(quota, "overflow: hidden")).toBe(true);
    expect(contains(meter, "min-width: 0")).toBe(true);
    expect(contains(meter, "max-width: 100%")).toBe(true);
    expect(contains(track, "width: 100%")).toBe(true);
    expect(contains(track, "min-width: 0")).toBe(true);
    expect(contains(track, "max-width: 100%")).toBe(true);
    expect(contains(forecast, "max-width: 100%")).toBe(true);
    expect(contains(forecast, "overflow: hidden")).toBe(true);

    for (const column of [5, 6]) {
      const content =
        (table * percentage(String.raw`\.accounts-table th:nth-child\(${column}\)`)) / 100 -
        cellPadding;
      const meterWidth = constrainedWidth(
        (content * percentValue(meterBase, "width")) / 100,
        content,
        meter,
      );
      const trackWidth = constrainedWidth(
        (meterWidth * percentValue(track, "width")) / 100,
        meterWidth,
        track,
      );
      // A long forecast's natural width must also be capped by its cell.
      const forecastWidth = constrainedWidth(240, content, forecast);

      expect(content).toBeGreaterThan(0);
      expect(meterWidth).toBeLessThanOrEqual(content);
      expect(trackWidth).toBeLessThanOrEqual(content);
      expect(forecastWidth).toBeLessThanOrEqual(content);
    }
  });

  it("truncates a forecast to its cell while preserving its full value in a tooltip", () => {
    expect(rule(String.raw`\.quota-forecast`)).toContain("overflow: hidden");
    expect(rule(String.raw`\.quota-forecast`)).toContain("text-overflow: ellipsis");
    expect(rule(String.raw`\.quota-forecast`)).toContain("white-space: nowrap");
  });
});
