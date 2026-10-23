import { describe, expect, it } from "vitest";
import * as core from "../src/index.ts";

describe("shared helpers", () => {
  it("recognizes objects and preserves error messages", () => {
    expect(core.isObj({})).toBe(true);
    for (const value of [null, [], "text", 1]) expect(core.isObj(value)).toBe(false);
    expect(core.errorText(new Error("failed"))).toBe("failed");
    expect(core.errorText("failed")).toBe("failed");
  });

  it("reuses formatters by zone and options without mixing options", () => {
    const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const formatter = core.zoneFormatter("UTC", opts);
    expect(core.zoneFormatter("UTC", { ...opts })).toBe(formatter);
    expect(formatter.format(0)).toBe("00:00");
    expect(core.zoneFormatter("Asia/Tokyo", opts).format(0)).toBe("09:00");
    expect(core.zoneFormatter("UTC", { year: "numeric" }).format(0)).toBe("1970");
    expect(core.zoneFormatter("UTC", opts)).toBe(formatter);
  });

  it("does not expose the retired HUD exports", () => {
    expect(core).not.toHaveProperty("NO_REVIEWS");
    expect(core).not.toHaveProperty("LOCK_HISTORY_NOTE");
  });
});
