import { flightDownText, flightNotTriagingText, flightStartFailedText } from "@mc/core";
import { describe, expect, it } from "vitest";
import { leftWakeText } from "../src/flight/state.ts";
import { sinceText } from "../src/hud.ts";
import { hubCodeHeldText } from "../src/update.ts";

// Hub alerts are read by a person who has never seen the project (#1582): no raw key, no 10+ digit
// number, no kind:key pattern, no ticket or PR number, no path or commit code.
const RAW = [/\d{10,}/, /[\w-]+:[\w./#-]+:\d/, /#\d+/, /\b[0-9a-f]{7,40}\b/, /\w\/\w/];
const expectPlain = (text: string): void => {
  for (const re of RAW) expect(text).not.toMatch(re);
};

const reason = (category: string, item: unknown) => ({
  id: `${category}:${JSON.stringify(item)}`,
  label: "ignored",
  targets: [],
});
const AT = Date.UTC(2026, 10, 7, 14, 30);

describe("the wake-left alert", () => {
  it("counts by kind in plain words and names the time", () => {
    const text = leftWakeText(
      [
        reason("prFlow", `1407:stage:clearance:${AT}`),
        reason("prFlow", `1408:unowned:${AT}`),
        reason("prs", "repo#12:9:true:open:review:"),
        reason("free", "GUIDO-1"),
        reason("items", "comms-open:42"),
        reason("signals", "seat_call:GUIDO-1"),
      ],
      AT,
      "Europe/London",
    );
    expect(text).toBe(
      "FLIGHT was woken at 14:30 about 6 things and left them undecided after two tries: 3 pull requests waiting for a next step, 1 free seat, 1 question waiting for an answer, 1 signal from the crew.",
    );
    expectPlain(text);
  });

  it("names every other kind of reason in words", () => {
    const text = leftWakeText(
      [
        reason("reviews", "idle"),
        reason("breaker", "tripped"),
        reason("planned", ["p1", AT, "check", "repo#12", "look again"]),
        reason("signals", "seat_call:GUIDO-1"),
        reason("items", "stall:GUIDO-1:x:y:1"),
      ],
      AT,
      "Europe/London",
    );
    expect(text).not.toMatch(/other thing/);
    expectPlain(text);
  });

  it("uses the singular for one", () => {
    const text = leftWakeText([reason("t", "repo#3")], AT, "Europe/London");
    expect(text).toBe(
      "FLIGHT was woken at 14:30 about 1 thing and left it undecided after two tries: 1 ticket ready to start.",
    );
  });
});

describe("the held-Update alert", () => {
  it("reads in plain words for both holds", () => {
    const code = hubCodeHeldText({
      commits: ["a1b2c3d4 one", "b2c3d4e5 two"],
      paths: ["apps/server/src/x.ts", "package.json", "loops/a.yaml"],
    });
    const link = hubCodeHeldText({
      commits: ["a1b2c3d4 one"],
      paths: ["docs/linked"],
      unsafePaths: ["docs/linked"],
    });
    for (const t of [code, link]) expectPlain(t);
    expect(code).toContain("2 changes touching 3 files");
    expect(link).toContain("1 change touching 1 file");
  });
});

describe("the not-triaging alert", () => {
  it("reads in plain words for every cause", () => {
    for (const cause of ["start-failed", "down", "stopped", "off", "late"] as const) {
      expectPlain(flightNotTriagingText(cause, 3, "14:30", null));
      expectPlain(flightNotTriagingText(cause, 0, null, null));
    }
    // the watch's notes carry the failure in words, never the raw error
    expectPlain(
      flightNotTriagingText(
        "start-failed",
        3,
        "14:30",
        flightStartFailedText("it would not start; the server log has the error"),
      ),
    );
    expectPlain(
      flightNotTriagingText(
        "down",
        3,
        "14:30",
        flightDownText("account claude-main is at its usage stop line"),
      ),
    );
    // the time the hub really puts in the text, today and before today
    const now = Date.UTC(2026, 10, 7, 16, 0);
    const today = sinceText(AT, now, "Europe/London");
    const before = sinceText(AT - 3 * 86_400_000, now, "Europe/London");
    expect(flightNotTriagingText("late", 3, today, null)).toContain("3 waiting since 14:30");
    for (const since of [today, before]) expectPlain(flightNotTriagingText("late", 3, since, null));
    expect(before).toBe("4 Nov 14:30");
  });
});
