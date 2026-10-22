import { describe, expect, it } from "vitest";
import { quotaWarnings, timeToFull } from "../src/quota.ts";
import { HOUR, limit5h, limit7d, NOW } from "./fixtures.ts";

const DAY = 24 * HOUR;
const TZ = "Europe/London";

describe("timeToFull", () => {
  it("is 'at limit' at 100 %", () => {
    expect(timeToFull(limit7d({ used: 100 }), NOW)).toBe("at limit");
    expect(timeToFull(limit5h({ used: 100 }), NOW)).toBe("at limit");
  });
  it("7d with fullAt: hours and minutes under a day, else days", () => {
    expect(timeToFull(limit7d({ fullAt: NOW + 3 * HOUR + 10 * 60_000 }), NOW)).toBe("~3h10");
    expect(timeToFull(limit7d({ fullAt: NOW + 5 * HOUR + 4 * 60_000 }), NOW)).toBe("~5h04");
    expect(timeToFull(limit7d({ fullAt: NOW + 2 * DAY + 6 * HOUR }), NOW)).toBe("~2d");
  });
  it("without fullAt a window does not fill, 5h included", () => {
    expect(timeToFull(limit7d({ fullAt: null }), NOW)).toBe("not filling at this rate");
    expect(timeToFull(limit5h(), NOW)).toBe("not filling at this rate");
  });
  it("a 5h window younger than the pace needs says there is too little history", () => {
    const young = (min: number) => limit5h({ resetAt: NOW + 5 * HOUR - min * 60_000 });
    expect(timeToFull(young(10), NOW)).toBe("too little history to tell");
    expect(timeToFull(young(29), NOW)).toBe("too little history to tell");
    expect(timeToFull(young(30), NOW)).toBe("not filling at this rate");
    // a 7d window is never judged by its age
    expect(timeToFull(limit7d({ fullAt: null, resetAt: NOW + 7 * 24 * HOUR - 60_000 }), NOW)).toBe(
      "not filling at this rate",
    );
  });
  it("a 5h row with paceReady false says there is too little history for a pace", () => {
    expect(timeToFull(limit5h({ paceReady: false }), NOW)).toBe("too little history for a pace");
    // even a window old enough by the clock: the server's word wins
    expect(timeToFull(limit5h({ paceReady: false, resetAt: NOW + HOUR }), NOW)).toBe(
      "too little history for a pace",
    );
  });
  it("a 5h row with paceReady true, or missing, shows the pace as before", () => {
    expect(timeToFull(limit5h({ paceReady: true, fullAt: NOW + 2 * HOUR }), NOW)).toBe("~2h00");
    expect(timeToFull(limit5h({ fullAt: NOW + 2 * HOUR }), NOW)).toBe("~2h00");
    expect(timeToFull(limit5h({ paceReady: true }), NOW)).toBe("not filling at this rate");
  });
  it("5h with fullAt reads like 7d", () => {
    expect(timeToFull(limit5h({ fullAt: NOW + 2 * HOUR }), NOW)).toBe("~2h00");
  });
});

describe("quotaWarnings", () => {
  it("names a window at its limit, and a 7d window that will fill", () => {
    const rows = [
      limit5h({ accountId: "claude-main", used: 100, resetAt: NOW + 2 * HOUR }),
      limit7d({ accountId: "codex-main", fullAt: NOW + 3 * HOUR + 10 * 60_000 }),
      limit7d({ accountId: "quiet", fullAt: null }),
    ];
    expect(quotaWarnings(rows, NOW, TZ)).toEqual([
      { crit: true, text: "claude-main 5h at its limit until 15:00" },
      { crit: false, text: "codex-main 7d full in ~3h10 at this rate (resets Sun 19:00)" },
    ]);
  });

  it("warns for a 5h window that will fill before it resets", () => {
    const rows = [limit5h({ accountId: "claude-main", fullAt: NOW + HOUR + 20 * 60_000 })];
    expect(quotaWarnings(rows, NOW, TZ)).toEqual([
      { crit: false, text: "claude-main 5h full in ~1h20 at this rate (resets 15:00)" },
    ]);
  });

  it("says a 7d window that is due now or within a minute is full now, not in ~0h00", () => {
    for (const fullAt of [NOW - HOUR, NOW, NOW + 59_000]) {
      expect(quotaWarnings([limit7d({ accountId: "a", fullAt })], NOW, TZ)).toEqual([
        { crit: false, text: "a 7d full at this rate now (resets Sun 19:00)" },
      ]);
    }
    expect(
      quotaWarnings([limit7d({ accountId: "a", fullAt: NOW + 60_000 })], NOW, TZ)[0]?.text,
    ).toBe("a 7d full in ~0h01 at this rate (resets Sun 19:00)");
  });
});
