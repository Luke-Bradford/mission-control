import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { apiPost } from "../src/api.ts";
import { HoldForm } from "../src/comms/HoldForm.tsx";
import { ACTIONS } from "../src/data.ts";
import { AskedOfYou } from "../src/flight/AskedOfYou.tsx";
import { holdConditionText } from "../src/flight/HeldNeeds.tsx";
import { stubFetch } from "./fetchStub.ts";
import { item } from "./fixtures.ts";

it("opens a Hold form and submits the reason and release condition", async () => {
  const fetch = stubFetch({
    "/api/attention/held": [],
    "POST /api/attention/demo/hold": { ok: true },
  });
  render(
    <HoldForm
      busy={false}
      onCancel={() => {}}
      onHold={(reason, condition) => void apiPost(ACTIONS.hold("demo"), { reason, condition })}
    />,
  );
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
it("lists a held item with its reason and condition, and Release returns it to Needs you", async () => {
  let released = false;
  const held = item({
    key: "held-demo",
    text: "Choose",
    hold: {
      reason: "Waiting",
      condition: { kind: "ticket", ticket: "mc#9" },
      by: "operator",
      at: 1,
    },
  });
  const fetch = stubFetch({
    "/api/attention/held": () => ({ status: 200, body: released ? [] : [held] }),
    "/api/attention": () => ({ status: 200, body: released ? [{ ...held, hold: undefined }] : [] }),
    "/api/notifications": { open: [], handledToday: [] },
    "POST /api/attention/held-demo/hold/release": () => {
      released = true;
      return { status: 200, body: { ok: true } };
    },
  });
  render(<AskedOfYou />);
  const row = await screen.findByTestId("held-row");
  expect(row.textContent).toContain("Choose");
  expect(row.textContent).toContain("Waiting · until mc#9 merges");
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/attention/held-demo/hold/release", expect.anything()),
  );
  await waitFor(() => expect(screen.queryByTestId("held-row")).toBeNull());
  expect((await screen.findByTestId("ask-row")).textContent).toContain("Choose");
});

it("words each release condition", () => {
  expect(holdConditionText({ kind: "manual" }, null)).toBe("until you release it");
  expect(holdConditionText({ kind: "crew" }, null)).toBe("until the crew resumes");
  expect(holdConditionText({ kind: "date", at: 1 }, null)).toBe("until a set date");
});

it("submits a ticket ref containing s and rejects whitespace", async () => {
  const fetch = stubFetch({
    "/api/attention/held": [],
    "POST /api/attention/demo/hold": { ok: true },
  });
  render(
    <HoldForm
      busy={false}
      onCancel={() => {}}
      onHold={(reason, condition) => void apiPost(ACTIONS.hold("demo"), { reason, condition })}
    />,
  );
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
