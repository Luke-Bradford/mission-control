import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  join(import.meta.dirname, "../../../scripts/controller-monitor.sh"),
  "utf8",
);
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** The jq program of the script's line that holds `marker`, the way the shell passes it. */
function filterOf(marker: string): string {
  const line = SCRIPT.split("\n").find((l) => l.includes(marker));
  const match = line?.match(/jq -r (?:--argjson n \$n )?'([^']*)'/);
  if (!match?.[1]) throw new Error(`no jq filter on the line with ${marker}`);
  return match[1];
}

const jq = (filter: string, input: unknown, args: string[] = []) =>
  execFileSync("jq", ["-r", ...args, filter], { input: JSON.stringify(input) })
    .toString()
    .trimEnd();

const stuckPr = filterOf("select(.loop.prNumber==$n)");
const controllerCheck = filterOf('test("controller check")');

const active = (prNumber: number, phase: string, text: string) => ({
  run: { id: `run-${prNumber}` },
  loop: { prNumber, phase, text },
  offSeatRuns: [] as unknown[],
});
const offSeat = (runId: string, prNumber: number, phase: string, text: string) => ({
  runId,
  loop: { prNumber, phase, text },
});

describe.skipIf(!hasJq)("the controller monitor's reads of /api/crew", () => {
  it("finds a PR's step on an off-seat run, from offSeatRuns alone", () => {
    const crew = {
      rows: [
        { ...active(1, "working", "x"), offSeatRuns: [offSeat("r9", 9, "parked", "Blocked: ci")] },
      ],
    };
    expect(jq(stuckPr, crew, ["--argjson", "n", "9"])).toBe("parked Blocked: ci");
  });

  it("finds a PR's step on an active run, and says none for a PR no run has", () => {
    const crew = { rows: [active(4, "review", "In review")] };
    expect(jq(stuckPr, crew, ["--argjson", "n", "4"])).toBe("review In review");
    expect(jq(stuckPr, crew, ["--argjson", "n", "5"])).toBe("none");
  });

  it("copes with a row that has no offSeatRuns or an empty one", () => {
    const bare = { run: { id: "a" }, loop: { prNumber: 2, phase: "ci", text: "CI" } };
    const crew = { rows: [bare, { ...active(3, "ci", "CI"), offSeatRuns: [] }] };
    expect(jq(stuckPr, crew, ["--argjson", "n", "2"])).toBe("ci CI");
    expect(jq(stuckPr, crew, ["--argjson", "n", "7"])).toBe("none");
  });

  it("raises a controller check for an off-seat run and for an active one", () => {
    const crew = {
      rows: [
        {
          ...active(1, "parked", "Waiting on the controller check"),
          offSeatRuns: [offSeat("r8", 8, "parked", "Waiting on the controller check\nmore")],
        },
        active(2, "working", "Working"),
      ],
    };
    expect(jq(controllerCheck, crew).split("\n")).toEqual([
      "r8\t8\tWaiting on the controller check more",
      "run-1\t1\tWaiting on the controller check",
    ]);
  });

  it("raises no controller check when no run waits on one", () => {
    const crew = {
      rows: [
        {
          ...active(2, "working", "Working"),
          offSeatRuns: [offSeat("r3", 3, "review", "In review")],
        },
      ],
    };
    expect(jq(controllerCheck, crew)).toBe("");
  });
});
