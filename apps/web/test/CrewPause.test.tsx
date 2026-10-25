import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { CrewPauseControl } from "../src/components/CrewPause.tsx";
import { seatStatus } from "../src/crew.ts";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG, seatRow } from "./fixtures.ts";

it("pauses selected seats with a reason and resumes the crew", async () => {
  let pause: unknown = null;
  const fetch = stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": () => ({ status: 200, body: pause }),
    "POST /api/settings/crew-pause": (init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      pause = body.seats === null ? null : { ...body, at: 1, by: "operator" };
      return { status: 200, body: pause };
    },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Save tokens" } });
  fireEvent.click(screen.getByLabelText("All seats"));
  const seat = CREW_CONFIG.crew?.sessions[0]?.seats[0];
  if (!seat) throw new Error("missing fixture seat");
  fireEvent.click(screen.getByLabelText(seat.id));
  fireEvent.click(screen.getByRole("button", { name: "Pause selected seats" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/crew-pause",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ seats: [seat.id], reason: "Save tokens" }),
      }),
    ),
  );
  expect(await screen.findByText("Paused: Save tokens")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Resume crew" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/crew-pause",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ seats: null }),
      }),
    ),
  );
});

it("shows the paused reason on crew status pills even for a live run", () => {
  expect(
    seatStatus({
      ...seatRow(),
      crewPause: { seats: "all", reason: "Save tokens", at: 1, by: "operator" },
    }),
  ).toEqual({ label: "Paused: Save tokens", tone: "warn" });
});
