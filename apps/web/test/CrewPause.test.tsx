import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { CrewPauseControl } from "../src/components/CrewPause.tsx";
import { seatStatus } from "../src/crew.ts";
import { hub } from "../src/data.ts";
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

it("shows who granted the run exception, its time and reason, while retaining the pause owner", async () => {
  const at = Date.UTC(2026, 10, 2, 12);
  const exception = {
    seat: "guido-1",
    runId: "guido-1:20261102-120000",
    by: "FLIGHT",
    at,
    reason: "Finish the approved fix only",
  };
  stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": {
      seats: "all",
      reason: "Save tokens",
      by: "operator",
      at: at - 1000,
      except: [exception],
      liftedBy: "FLIGHT",
    },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  const audit = screen.getByRole("region", { name: "Crew pause audit" });
  expect(audit.textContent).toContain("Paused by operator");
  expect(audit.textContent).toContain("FLIGHT let guido-1 continue");
  expect(audit.textContent).toContain(`Run ${exception.runId}`);
  expect(audit.textContent).toContain("2026-11-02 12:00:00 UTC");
  expect(audit.textContent).toContain(exception.reason);
  expect(audit.textContent).toContain("Other tickets still wait");
});

it("states when the pause has no run exceptions", async () => {
  stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": {
      seats: "all",
      reason: "Save tokens",
      by: "operator",
      at: 1,
    },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  expect(screen.getByText("No run exceptions.")).toBeTruthy();
});

it("labels older seat-only records without inventing a run or grantor", async () => {
  stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": {
      seats: "all",
      reason: "Save tokens",
      by: "operator",
      at: 1,
      legacyExcept: ["guido-1"],
      except: [],
    },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  expect(screen.getByText(/Older seat-only entries: guido-1/)).toBeTruthy();
  expect(screen.getByText(/Their run and grantor are unknown/)).toBeTruthy();
});

it("does not invent an owner or 1970 timestamp for the unreadable-record fallback", async () => {
  stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": {
      seats: "all",
      reason: "Crew pause setting is unreadable",
      by: "operator",
      at: 0,
    },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  expect(screen.getByText("Pause record unreadable; owner and time unknown.")).toBeTruthy();
  expect(screen.queryByText(/1970/)).toBeNull();
});

it("refreshes run exceptions when a run ends and the agents topic changes", async () => {
  const exception = {
    seat: "guido-1",
    runId: "one-run",
    by: "FLIGHT",
    at: 2,
    reason: "Finish this run",
  };
  const pause = { seats: "all", reason: "Save tokens", by: "operator", at: 1, except: [exception] };
  stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": () => ({ status: 200, body: pause }),
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  expect(screen.getByText("Run one-run")).toBeTruthy();
  pause.except = [];
  hub.refetchTopic("agents");
  expect(await screen.findByText("No run exceptions.")).toBeTruthy();
  expect(screen.queryByText("Run one-run")).toBeNull();
});

it("shows an explicit read failure and keeps pause controls disabled", async () => {
  stubFetch({ "/api/config": CREW_CONFIG });
  render(<CrewPauseControl />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Crew pause could not be loaded. Reload the page to retry.",
  );
  expect(screen.getByRole("button", { name: "Pause crew" }).hasAttribute("disabled")).toBe(true);
});

it("keeps a stale pause visible but refuses writes after a refresh fails", async () => {
  let failed = false;
  const fetch = stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": () =>
      failed
        ? { status: 503, body: { error: "Unavailable" } }
        : { status: 200, body: { seats: "all", reason: "Save tokens", by: "operator", at: 1 } },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  failed = true;
  hub.refetchTopic("settings");
  await screen.findByRole("alert");
  expect(screen.getByText("Paused")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume crew" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Pause all seats" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.submit(screen.getByLabelText("Reason").closest("form") as HTMLFormElement);
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
