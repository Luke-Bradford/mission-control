import type { FlightScheduleEntry } from "@mc/core";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { Timeline } from "../src/flight/Timeline.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, limit5h, MIN, NOW } from "./fixtures.ts";

const plan = (
  id: string,
  minutes: number,
  kind: FlightScheduleEntry["kind"],
  label: string,
): FlightScheduleEntry => ({
  id,
  dueAt: NOW + minutes * MIN,
  kind,
  target: "example",
  label,
  status: "pending",
  title: label,
  at: NOW,
  createdAt: NOW,
  minutesFromNow: minutes,
  overdue: minutes < 0,
});
const entries = [
  plan("report", -5, "report", "NETWORK-1 reports on the Example listing gap"),
  plan("recheck", 84, "PR recheck", "Re-check PR #2368 after the nudge"),
  plan("brief", 190, "brief", "Standup brief ready"),
  plan("twin-a", 190, "brief", "Standup brief ready"),
  plan("later", 300, "PR recheck", "NW #2302: check the migration has run"),
];
function stub(schedule: unknown = { session: "s1", entries }) {
  stubFetch({
    "/api/config": CONFIG,
    "/api/limits": [limit5h({ resetAt: NOW + 26 * MIN })],
    "/api/health": [{ collector: "github:shop-app", at: NOW }],
    "/api/flight/schedule": schedule,
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
});

it("merges all planned kinds, overdue and identical simultaneous events with polls/resets and Later", async () => {
  stub();
  const { container } = render(<Timeline />);
  await waitFor(() => expect(container.querySelectorAll(".tlev")).toHaveLength(6));
  const markers = [...container.querySelectorAll<HTMLElement>(".tlev")];
  expect(markers[0]?.style.left).toBe("0%");
  expect(markers[0]?.title).toContain("12:55 NETWORK-1 reports");
  expect(markers[4]?.classList.contains("r")).toBe(true);
  expect(container.querySelector(".tllater")?.textContent).toBe(
    "Later: Sat 18:00 NW #2302: check the migration has run",
  );
  const narrow = container.querySelector(".tlnext.narrow");
  expect(narrow?.textContent).toContain("Re-check PR #2368 after the nudge");
  expect(narrow?.textContent?.match(/Standup brief ready/g)).toHaveLength(2);
  // The timeline is read-only: all labels are text, with no keyboard-only action to miss.
  expect(container.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
  stub({
    session: "s1",
    entries: entries.map((e, i) => ({ ...e, status: i % 2 ? "completed" : "cancelled" })),
  });
  await act(async () => hub.refetchTopic("flight"));
  await waitFor(() => expect(container.querySelectorAll(".tlev")).toHaveLength(2));
  expect(container.textContent).toContain("claude-main 5h window resets");
  expect(container.textContent).not.toContain("Standup brief ready");
  expect(container.querySelector(".tllater")).toBeNull();
});

it.each(["loading", "empty", "failed"])(
  "keeps quota resets visible with a %s schedule",
  async (state) => {
    stub(
      state === "failed"
        ? () => ({ status: 503, body: { error: "unavailable" } })
        : { session: null, entries: [] },
    );
    if (state === "loading") {
      const fetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string, init?: RequestInit) =>
          input === RESOURCES.flightSchedule.path
            ? new Promise<Response>(() => {})
            : fetch(input, init),
        ),
      );
    }
    const { container } = render(<Timeline />);
    await waitFor(() => expect(container.querySelectorAll(".tlev")).toHaveLength(2));
    expect(container.textContent).toContain("claude-main 5h window resets");
    const snapshot = hub.snapshot(RESOURCES.flightSchedule.path, "flight");
    expect(snapshot.loading).toBe(state === "loading");
    expect(snapshot.error !== null).toBe(state === "failed");
  },
);
