import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { NeedsList } from "../src/comms/NeedsList.tsx";
import { stubFetch } from "./fetchStub.ts";
import { item } from "./fixtures.ts";

it("opens a Hold form and submits the reason and release condition", async () => {
  const fetch = stubFetch({
    "/api/attention/held": [],
    "POST /api/attention/demo/hold": { ok: true },
  });
  render(
    <NeedsList
      items={[item({ key: "demo" })]}
      rows={[]}
      onAskFlight={() => {}}
      onRead={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold…" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Waiting for review" } });
  fireEvent.click(screen.getByRole("button", { name: "Hold item" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/attention/demo/hold",
      expect.objectContaining({
        body: JSON.stringify({ reason: "Waiting for review", condition: { kind: "manual" } }),
      }),
    ),
  );
});
it("shows a collapsed Held list with a reason and one-click release", async () => {
  const fetch = stubFetch({
    "/api/attention/held": [
      item({
        key: "held-demo",
        text: "Choose",
        hold: { reason: "Waiting", condition: { kind: "manual" }, by: "operator", at: 1 },
      }),
    ],
    "POST /api/attention/held-demo/hold/release": { ok: true },
  });
  render(<NeedsList items={[]} rows={[]} onAskFlight={() => {}} onRead={() => {}} />);
  const summary = await screen.findByText("Held · 1");
  expect(summary.closest("details")?.open).toBe(false);
  fireEvent.click(summary);
  expect(screen.getByText("Waiting")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/attention/held-demo/hold/release", expect.anything()),
  );
});

it("submits a ticket ref containing s and rejects whitespace", async () => {
  const fetch = stubFetch({
    "/api/attention/held": [],
    "POST /api/attention/demo/hold": { ok: true },
  });
  render(
    <NeedsList
      items={[item({ key: "demo" })]}
      rows={[]}
      onAskFlight={() => {}}
      onRead={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold…" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Waiting" } });
  fireEvent.change(screen.getByLabelText("Release condition"), { target: { value: "ticket" } });
  const ticket = screen.getByLabelText("Ticket") as HTMLInputElement;
  fireEvent.change(ticket, { target: { value: "mission-control#638" } });
  expect(ticket.checkValidity()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Hold item" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/attention/demo/hold",
      expect.objectContaining({
        body: JSON.stringify({
          reason: "Waiting",
          condition: { kind: "ticket", ticket: "mission-control#638" },
        }),
      }),
    ),
  );
  fireEvent.change(ticket, { target: { value: "bad ref#638" } });
  expect(ticket.checkValidity()).toBe(false);
});
