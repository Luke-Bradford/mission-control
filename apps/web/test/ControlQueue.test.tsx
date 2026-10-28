import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { ControlQueue } from "../src/flight/ControlQueue.tsx";
import { NEEDS_YOU_PATH } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, item } from "./fixtures.ts";

beforeEach(() => hub.clear());
afterEach(() => {
  hub.clear();
  vi.restoreAllMocks();
});

it("labels FLIGHT's items as waiting on a down FLIGHT in Clear now", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/attention": [
      item({ key: "t", kind: "tag", text: "Seat tag", owner: "flight", flightTriage: "down" }),
      item({ key: "m", text: "Mine" }),
    ],
  });
  render(<ControlQueue onOpenQueue={() => {}} />);
  const row = (await screen.findByText("Seat tag")).closest("li") as HTMLElement;
  expect(within(row).getByText("Waiting on FLIGHT — not triaging")).toBeTruthy();
  const mine = screen.getByText("Mine").closest("li") as HTMLElement;
  expect(within(mine).queryByText("Waiting on FLIGHT — not triaging")).toBeNull();
});

it("sends FLIGHT not triaging to Needs you's home, where its items are listed (#758)", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/attention": [
      item({
        key: "flight:not-triaging",
        kind: "blocked",
        escalationId: null,
        text: "FLIGHT is stopped: 1 waiting since 12:55.",
        notTriaging: { cause: "stopped", keys: ["t"], since: 0 },
      }),
      item({ key: "t", kind: "tag", text: "Seat tag", owner: "flight", flightTriage: "down" }),
    ],
  });
  render(<ControlQueue onOpenQueue={() => {}} />);
  const row = (await screen.findByText("FLIGHT is stopped: 1 waiting since 12:55.")).closest(
    "li",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Show them" }));
  expect(window.location.pathname + window.location.hash).toBe(NEEDS_YOU_PATH);
});
