import { afterEach, describe, expect, it } from "vitest";
import {
  ago,
  bytes,
  cost,
  dayLabel,
  dayMonth,
  dur,
  hhmm,
  hms,
  isoDay,
  kTokens,
  mss,
  narrowDay,
  rel,
  untilLabel,
  wkdTime,
} from "../src/fmt.ts";
import { HOUR, MIN, NOW } from "./fixtures.ts";

const TZ = "Europe/London";
const SEC = 1000;
const DAY = 24 * HOUR;

describe("clock formats", () => {
  it("hhmm, wkdTime and dayMonth in the operator's timezone", () => {
    // NOW = Sat 17 Oct 2026 12:00 UTC = 13:00 BST
    expect(hhmm(NOW, TZ)).toBe("13:00");
    expect(hhmm(NOW + 65 * MIN, TZ)).toBe("14:05");
    expect(hhmm(NOW, "UTC")).toBe("12:00");
    expect(hhmm(Date.UTC(2026, 9, 17, 23, 5), TZ)).toBe("00:05");
    expect(wkdTime(Date.UTC(2026, 9, 21, 7, 0), TZ)).toBe("Wed 08:00");
    expect(dayMonth(Date.UTC(2026, 9, 18, 9), TZ)).toBe("18 Oct");
    // 23:30 UTC on the 17th is already the 18th in London
    expect(dayMonth(Date.UTC(2026, 9, 17, 23, 30), TZ)).toBe("18 Oct");
  });

  it("names months and weekdays with three letters, September included", () => {
    // ICU's en-GB short month for September is "Sept"
    expect(dayMonth(Date.UTC(2026, 8, 18, 9), TZ)).toBe("18 Sep");
    expect(dayMonth(Date.UTC(2026, 0, 1, 9), TZ)).toBe("1 Jan");
    expect(dayMonth(Date.UTC(2026, 11, 31, 9), TZ)).toBe("31 Dec");
    expect(wkdTime(Date.UTC(2026, 8, 17, 13, 30), TZ)).toBe("Thu 14:30");
    expect(wkdTime(Date.UTC(2026, 9, 18, 23, 30), TZ)).toBe("Mon 00:30"); // already Monday in London
  });

  it("mss folds hours into minutes; hms is the MET clock", () => {
    expect(mss(0)).toBe("0:00");
    expect(mss(5 * SEC)).toBe("0:05");
    expect(mss(11 * MIN + 2 * SEC + 999)).toBe("11:02");
    expect(mss(HOUR + 5 * MIN)).toBe("65:00");
    expect(mss(-5 * SEC)).toBe("0:00");
    expect(hms(3 * HOUR + 12 * MIN + 40 * SEC)).toBe("03:12:40");
    expect(hms(HOUR + 2 * MIN + 3 * SEC + 999)).toBe("01:02:03");
    expect(hms(0)).toBe("00:00:00");
    expect(hms(-1)).toBe("00:00:00");
  });
});

describe("ago and rel", () => {
  it("ago counts local days, not 24-hour spans", () => {
    expect(ago(NOW, NOW, TZ)).toBe("today");
    expect(ago(NOW - 12 * HOUR, NOW, TZ)).toBe("today"); // 01:00 BST the same day
    expect(ago(NOW - 14 * HOUR, NOW, TZ)).toBe("1d ago"); // 23:00 BST the day before
    expect(ago(NOW - 3 * DAY, NOW, TZ)).toBe("3d ago");
    expect(ago(NOW + HOUR, NOW, TZ)).toBe("today");
    // across the clocks going back on 25 Oct: still whole days
    const after = Date.UTC(2026, 9, 26, 12);
    expect(ago(Date.UTC(2026, 9, 24, 12), after, TZ)).toBe("2d ago");
  });

  it("rel floors each unit and falls back to the day form", () => {
    expect(rel(NOW + MIN, NOW, TZ)).toBe("just now");
    expect(rel(NOW, NOW, TZ)).toBe("just now");
    expect(rel(NOW - 59 * SEC, NOW, TZ)).toBe("just now");
    expect(rel(NOW - MIN, NOW, TZ)).toBe("1 min ago");
    expect(rel(NOW - 119 * MIN - 59 * SEC, NOW, TZ)).toBe("119 min ago");
    expect(rel(NOW - 120 * MIN, NOW, TZ)).toBe("2 h ago");
    expect(rel(NOW - 47 * HOUR - 59 * MIN, NOW, TZ)).toBe("47 h ago");
    expect(rel(NOW - 48 * HOUR, NOW, TZ)).toBe("2d ago");
  });
});

describe("kTokens", () => {
  it.each([
    [0, "0"],
    [950, "950"],
    [999.4, "999"],
    [999.6, "1.0k"],
    [1_000, "1.0k"],
    [60_100, "60.1k"],
    [99_940, "99.9k"],
    [99_960, "100k"], // rounds to 100.0k: the unit is chosen after rounding
    [612_000, "612k"],
    [999_400, "999k"],
    [999_600, "1.00M"],
    [1_240_000, "1.24M"],
    [9_994_000, "9.99M"],
    [9_996_000, "10.0M"],
    [18_400_000, "18.4M"],
  ])("%d → %s", (n, s) => {
    expect(kTokens(n)).toBe(s);
  });
});

describe("bytes", () => {
  it.each([
    [512, "512 B"],
    [3.4 * 2 ** 10, "3.4 KB"],
    [12.3 * 2 ** 20, "12.3 MB"],
    [1.2 * 2 ** 30, "1.20 GB"],
  ])("%d → %s", (n, expected) => {
    expect(bytes(n)).toBe(expected);
  });
});

describe("cost", () => {
  it("is an API-equivalent estimate, or a dash", () => {
    expect(cost(1.8412)).toBe("~$1.84");
    expect(cost(0)).toBe("~$0.00");
    expect(cost(null)).toBe("—");
  });
});

describe("dur", () => {
  it.each([
    [0, "<0.1s"],
    [49, "<0.1s"],
    [50, "0.1s"],
    [3_400, "3.4s"],
    [9_940, "9.9s"],
    [9_960, "10s"],
    [42_000, "42s"],
    [59_400, "59s"],
    [59_600, "1m 00s"],
    [6 * MIN + 5 * SEC, "6m 05s"],
    [59 * MIN + 59 * SEC + 400, "59m 59s"],
    [59 * MIN + 59 * SEC + 600, "1h 00m"],
    [HOUR + 5 * MIN, "1h 05m"],
    [HOUR + 12 * MIN, "1h 12m"],
  ])("%d ms → %s", (ms, s) => {
    expect(dur(ms)).toBe(s);
  });
});

describe("untilLabel and isoDay", () => {
  const TZ_BEFORE = process.env.TZ;
  afterEach(() => {
    if (TZ_BEFORE === undefined) delete process.env.TZ;
    else process.env.TZ = TZ_BEFORE;
  });

  it("untilLabel names the weekday and date", () => {
    expect(untilLabel("2026-10-28")).toBe("until Wed 28 Oct");
    expect(untilLabel("2026-09-01")).toBe("until Tue 1 Sep");
    expect(untilLabel("2027-01-01")).toBe("until Fri 1 Jan");
  });

  it("untilLabel of no date is until you turn it off", () => {
    expect(untilLabel("")).toBe("until you turn it off");
  });

  it("untilLabel does not shift a day in a timezone west of UTC", () => {
    // new Date("2026-10-28T00:00") in Los Angeles is 07:00 UTC, but 2026-10-28 parsed as UTC and
    // shown in Los Angeles would be the 27th: neither must happen
    process.env.TZ = "America/Los_Angeles";
    expect(untilLabel("2026-10-28")).toBe("until Wed 28 Oct");
    process.env.TZ = "Pacific/Auckland";
    expect(untilLabel("2026-10-28")).toBe("until Wed 28 Oct");
  });

  it("isoDay is the local date plus some days", () => {
    // NOW = Sat 17 Oct 2026 13:00 BST
    expect(isoDay(NOW, "Europe/London")).toBe("2026-10-17");
    expect(isoDay(NOW, "Europe/London", 10)).toBe("2026-10-27");
    // 23:30 UTC on the 17th is already the 18th in London, not in Reykjavik
    expect(isoDay(Date.UTC(2026, 9, 17, 23, 30), "Europe/London")).toBe("2026-10-18");
    expect(isoDay(Date.UTC(2026, 9, 17, 23, 30), "Atlantic/Reykjavik")).toBe("2026-10-17");
    // month and year roll
    expect(isoDay(Date.UTC(2026, 9, 25, 12), "Europe/London", 10)).toBe("2026-11-04");
    expect(isoDay(Date.UTC(2026, 11, 25, 12), "Europe/London", 10)).toBe("2027-01-04");
  });
});

describe("calendar days", () => {
  it("dayLabel and narrowDay read the YYYY-MM-DD parts, whatever the zone", () => {
    expect(dayLabel("2026-10-17")).toBe("Sat 17 Oct");
    expect(narrowDay("2026-10-17")).toBe("S17");
    expect(dayLabel("2026-09-01")).toBe("Tue 1 Sep");
    expect(dayLabel("not a day")).toBe("not a day");
    expect(narrowDay("2026-13-01")).toBe("2026-13-01");
  });
});
