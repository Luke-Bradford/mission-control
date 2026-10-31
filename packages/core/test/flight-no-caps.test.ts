import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLIGHT_MIN_WAKE_GAP_MS,
  FLIGHT_RUNAWAY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  runawayRefusedText,
} from "../src/flight.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const sources = [
  join(root, "packages/core/src/flight.ts"),
  ...readdirSync(join(root, "apps/server/src/flight")).map((f) =>
    join(root, "apps/server/src/flight", f),
  ),
];

describe("FLIGHT has no per-action caps", () => {
  it.each(["PER_HOUR", "PER_RUN", "PER_SEAT_HOUR", "TICKET_RESTART", "PER_HEAD"])(
    "no %s limit remains in flight.ts or the flight server code",
    (word) => {
      const found = sources.filter((f) => readFileSync(f, "utf8").includes(word));
      expect(found).toEqual([]);
    },
  );

  it("keeps the wake debounce, and has the one runaway breaker", () => {
    expect(FLIGHT_MIN_WAKE_GAP_MS).toBeGreaterThan(0);
    expect(FLIGHT_RUNAWAY).toEqual({
      writesPerHour: 200,
      sameActionLimit: 5,
      sameActionWindowMs: 30 * 60_000,
    });
    expect(FLIGHT_RUNAWAY_NOTE_KEY).toBe("flight-runaway");
    expect(runawayRefusedText("a loop")).toContain("runaway breaker");
  });
});
