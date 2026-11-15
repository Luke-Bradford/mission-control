import { describe, expect, it } from "vitest";
import { eventLine } from "../../web/src/ticket/ticketTimeline.ts";

type RunEvent = Parameters<typeof eventLine>[0];

const run = (extra: Record<string, unknown>): RunEvent =>
  ({ kind: "run", at: 1, seat: "GUIDO-1", status: "ended", ...extra }) as unknown as RunEvent;

describe("ticket timeline run line", () => {
  it("shows what the run ran on beside the planner's recommendation", () => {
    const line = eventLine(
      run({
        model: "sonnet-5.5",
        effort: "medium",
        advice: {
          step: "build",
          model: "opus-5.5",
          effort: "high",
          reason: "Touches the supervisor.",
          by: "planner",
          at: 1,
        },
      }),
    );
    expect(line).toContain(
      "ran sonnet-5.5 medium; recommended opus-5.5 high by the planner: Touches the supervisor.",
    );
  });

  it("shows only the actual model for a run with no advice", () => {
    const line = eventLine(run({ model: "sonnet-5.5", effort: "medium" }));
    expect(line).toContain("ran sonnet-5.5 medium");
    expect(line).not.toContain("recommended");
  });

  it("adds nothing for a run with neither", () => {
    const line = eventLine(run({}));
    expect(line).not.toContain("ran ");
    expect(line).not.toContain("recommended");
  });
});
