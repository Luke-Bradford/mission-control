import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { ControlQueue } from "../src/flight/ControlQueue.tsx";
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
  expect(within(row).getByText("Waiting on FLIGHT — FLIGHT is down")).toBeTruthy();
  const mine = screen.getByText("Mine").closest("li") as HTMLElement;
  expect(within(mine).queryByText("Waiting on FLIGHT — FLIGHT is down")).toBeNull();
});
