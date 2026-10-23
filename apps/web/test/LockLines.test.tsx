import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockLines } from "../src/components/LockLines.tsx";
import { LockBox } from "../src/overview/LockBox.tsx";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LockLines", () => {
  it("lists two waiting calls from one run as two rows, without a duplicate-key warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.now();
    render(
      <LockLines
        lock={{
          holder: { runId: "inco-1:x", seatId: "inco-1", command: "pnpm -s test", since: now },
          waiting: [
            { runId: "guido-1:x", seatId: "guido-1", since: now },
            { runId: "guido-1:x", seatId: "guido-1", since: now },
          ],
        }}
      />,
    );
    expect(screen.getAllByText(/GUIDO-1/)).toHaveLength(2);
    expect(errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).not.toMatch(
      /same key/,
    );
  });
});

it.each([false, true])(
  "shows usual duration and over status (%s) in both lock displays",
  async (over) => {
    const now = Date.now();
    const lock = {
      holder: {
        runId: "r",
        seatId: "inco-1",
        command: "just test",
        since: now - (over ? 600000 : 60000),
      },
      waiting: [],
    };
    stubFetch({
      "/api/test-lock": lock,
      "/api/test-lock/history": {
        runs: [],
        today: { runs: 0, waitMs: 0 },
        usualMs: { "just test": 540000 },
      },
    });
    render(
      <>
        <LockLines lock={lock} />
        <LockBox />
      </>,
    );
    const text = `usually about 9 min${over ? " · over its usual time" : ""}`;
    expect(await screen.findAllByText(text, { exact: false })).toHaveLength(2);
  },
);

it("omits usual duration for a command without enough history", async () => {
  const lock = {
    holder: { runId: "r", seatId: "inco-1", command: "unknown", since: Date.now() },
    waiting: [],
  };
  stubFetch({
    "/api/test-lock": lock,
    "/api/test-lock/history": { runs: [], today: { runs: 0, waitMs: 0 }, usualMs: {} },
  });
  render(
    <>
      <LockLines lock={lock} />
      <LockBox />
    </>,
  );
  await screen.findByText("Open INCO-1");
  expect(screen.queryByText(/usually about/)).toBeNull();
});
