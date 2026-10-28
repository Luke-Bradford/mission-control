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
  const paused = await screen.findByText("Paused");
  expect(paused.parentElement?.getAttribute("title")).toBe("Save tokens");
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

it("keeps the paused reason out of crew status pills even for a live run", () => {
  expect(
    seatStatus({
      ...seatRow(),
      crewPause: { seats: "all", reason: "Save tokens", at: 1, by: "operator" },
    }),
  ).toEqual({ label: "Paused", tone: "warn", reason: "Save tokens" });
});

it("offers watch seats and renders the form outside clipping panels", async () => {
  const config = structuredClone(CREW_CONFIG);
  const seat = config.crew?.sessions[0]?.seats[0];
  if (!seat) throw new Error("missing fixture seat");
  seat.loop = "watch";
  stubFetch({ "/api/config": config, "/api/settings/crew-pause": null });
  const { container } = render(
    <div style={{ overflow: "hidden" }}>
      <CrewPauseControl />
    </div>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.click(screen.getByLabelText("All seats"));
  expect(screen.getByLabelText(seat.id)).toBeTruthy();
  const form = screen.getByLabelText("Reason").closest("form");
  expect(form).toBeTruthy();
  expect(container.contains(form)).toBe(false);
  expect(document.body.contains(form)).toBe(true);
});
