import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  latestRollout,
  latestTranscriptLimits,
  readTail,
} from "../src/collectors/usage-sources.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-usage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ev = (five: number, seven: number) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: five, resetsAt: 1792245600 },
        seven_day: { utilization: seven, resetsAt: 1792548000 },
      },
    },
  });
const put = (p: string, body: string, mtimeS: number) => {
  writeFileSync(p, body);
  utimesSync(p, mtimeS, mtimeS);
};

describe("readTail", () => {
  it("returns whole small files and only the tail (whole lines) of big ones", () => {
    const p = join(dir, "a.log");
    writeFileSync(p, "one\ntwo\nthree\n");
    expect(readTail(p, 1000)).toBe("one\ntwo\nthree\n");
    const big = `${"x".repeat(5000)}\nlast1\nlast2\n`;
    writeFileSync(p, big);
    const t = readTail(p, 20);
    expect(t).toBe("last1\nlast2\n");
  });
});

describe("latestTranscriptLimits", () => {
  /** "Now" for these tests: just after the newest fixture mtime (3000 s), well inside 1h. */
  const T = { now: 3_100_000 };
  it("scans newest file first across state and logs dirs, using the file mtime as at", () => {
    const state = join(dir, "state");
    const logs = join(dir, "logs");
    mkdirSync(state);
    mkdirSync(logs);
    put(join(state, "iteration-1.log"), `${ev(0.1, 0.2)}\n`, 1000);
    put(
      join(logs, "fire.20261017-010101.log"),
      `${ev(0.3, 0.4)}\n${ev(0.5, 0.6)}\nnot json\n`,
      2000,
    );
    const r = latestTranscriptLimits([{ stateDir: state, logsDir: logs }], T);
    expect(r.map((x) => [x.window, x.utilization, x.at])).toEqual([
      ["5h", 50, 2_000_000],
      ["7d", 60, 2_000_000],
    ]);
  });

  it("floors a fractional file mtime to integer ms", () => {
    const state = join(dir, "state");
    mkdirSync(state);
    put(join(state, "iteration-1.log"), `${ev(0.1, 0.2)}\n`, 1000.1234567);
    const r = latestTranscriptLimits([{ stateDir: state }], T);
    expect(r.length).toBe(2);
    for (const x of r) expect(Number.isInteger(x.at)).toBe(true);
  });

  it("skips newer files with no event and reads only the tail of large files", () => {
    const state = join(dir, "s");
    mkdirSync(state);
    put(join(state, "iteration-old.log"), `${ev(0.1, 0.2)}\n`, 1000);
    put(join(state, "iteration-new.log"), "no events here\n", 3000);
    expect(latestTranscriptLimits([{ stateDir: state }], T)[0]?.utilization).toBe(10);
    // event beyond the tail window is not seen
    put(
      join(state, "iteration-new.log"),
      `${ev(0.9, 0.9)}\n${"y".repeat(3 * 1024 * 1024)}\n`,
      3000,
    );
    expect(latestTranscriptLimits([{ stateDir: state }], T)[0]?.utilization).toBe(10);
  });

  it("stops at files older than now - maxAgeMs: their readings would be unusable anyway", () => {
    const state = join(dir, "state");
    mkdirSync(state);
    put(join(state, "iteration-old.log"), `${ev(0.1, 0.2)}\n`, 1000);
    expect(latestTranscriptLimits([{ stateDir: state }], { now: 1000_000 + 3600e3 })).toHaveLength(
      2,
    );
    expect(
      latestTranscriptLimits([{ stateDir: state }], { now: 1000_000 + 3600e3 + 1000 }),
    ).toEqual([]);
    expect(
      latestTranscriptLimits([{ stateDir: state }], { now: 1000_000 + 120_000, maxAgeMs: 60_000 }),
    ).toEqual([]);
  });

  it("reads at most 50 files, newest first", () => {
    const state = join(dir, "state");
    mkdirSync(state);
    put(join(state, "iteration-event.log"), `${ev(0.1, 0.2)}\n`, 2000);
    for (let i = 0; i < 49; i++) put(join(state, `iteration-n${i}.log`), "nothing\n", 2001 + i);
    expect(latestTranscriptLimits([{ stateDir: state }], T)).toHaveLength(2); // the 50th file
    put(join(state, "iteration-n49.log"), "nothing\n", 2050);
    expect(latestTranscriptLimits([{ stateDir: state }], T)).toEqual([]); // now the 51st
  });

  it("returns [] with no files or missing dirs", () => {
    expect(
      latestTranscriptLimits([{ stateDir: join(dir, "nope"), logsDir: join(dir, "nope2") }], T),
    ).toEqual([]);
  });
});

describe("latestRollout", () => {
  const tc = (used: number) =>
    JSON.stringify({
      timestamp: "2026-10-17T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: used, window_minutes: 10080, resets_at: 1792649881 },
          secondary: null,
        },
      },
    });

  it("takes the last token_count of the newest rollout that has one, with its timestamp", () => {
    const day = join(dir, "2026", "10", "17");
    mkdirSync(day, { recursive: true });
    put(join(day, "rollout-a.jsonl"), `${tc(1)}\n`, 1000);
    put(join(day, "rollout-b.jsonl"), `${tc(2)}\n${tc(3)}\n`, 2000);
    put(join(day, "rollout-c.jsonl"), `{"type":"other"}\n`, 3000);
    const r = latestRollout(dir) as {
      at: number;
      rate_limits: { primary: { used_percent: number } };
    };
    expect(r.rate_limits.primary.used_percent).toBe(3);
    expect(r.at).toBe(Date.parse("2026-10-17T10:00:00.000Z"));
  });

  it("floors a fractional rollout mtime when the event has no timestamp", () => {
    const day = join(dir, "2026", "10", "17");
    mkdirSync(day, { recursive: true });
    const noTs = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: 1, window_minutes: 10080, resets_at: 1792649881 } },
      },
    });
    put(join(day, "rollout-a.jsonl"), `${noTs}\n`, 1000.1234567);
    const r = latestRollout(dir) as { at: number };
    expect(Number.isInteger(r.at)).toBe(true);
  });

  it("returns null when there are no rollouts", () => {
    expect(latestRollout(join(dir, "none"))).toBeNull();
  });
});
