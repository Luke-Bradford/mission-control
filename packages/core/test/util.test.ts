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

describe("the operator's locale", () => {
  const at = Date.UTC(2026, 10, 22, 12, 0);
  const date = { day: "numeric", month: "numeric", year: "numeric" } as const;

  it("formats in en-GB unless a locale is given, without mixing the two", () => {
    expect(core.DEFAULT_LOCALE).toBe("en-GB");
    expect(core.zoneFormatter("UTC", date).format(at)).toBe("22/11/2026");
    expect(core.zoneFormatter("UTC", date, "en-US").format(at)).toBe("11/22/2026");
    expect(core.zoneFormatter("UTC", date).format(at)).toBe("22/11/2026");
  });

  it("names a delivered time in the given locale", () => {
    expect(core.commsStateLine("delivered", at, "UTC", "en-US")).toMatch(/^Delivered 12:00/);
  });
});
