import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewPauseControl } from "../src/components/CrewPause.tsx";
import { seatStatus } from "../src/crew.ts";
import { hub } from "../src/data.ts";
import { installKeys } from "../src/shell/keys.ts";
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

/** The pause control over a server that answers writes by `write`, and records every POST body. */
function setupPause(write: (init: RequestInit | undefined) => { status: number; body: unknown }) {
  const posts: unknown[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      const out = write(init);
      return new Response(JSON.stringify(out.body), { status: out.status });
    }
    const body = input === "/api/config" ? CREW_CONFIG : null;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  render(<CrewPauseControl />);
  return posts;
}

const summaryOf = () => screen.getByRole("region", { name: "The crew pause was not saved" });

it("empty selection links to the seat list", async () => {
  const posts = setupPause(() => ({ status: 200, body: null }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Save tokens" } });
  fireEvent.click(screen.getByLabelText("All seats"));
  fireEvent.click(screen.getByRole("button", { name: "Pause selected seats" }));
  const summary = summaryOf();
  expect(document.activeElement).toBe(summary);
  fireEvent.click(within(summary).getByRole("link", { name: /Choose at least one seat/ }));
  expect(document.activeElement).toBe(screen.getByRole("group", { name: "Seats to pause" }));
  expect(posts).toHaveLength(0);
});

it("an empty reason focuses a named summary whose link reaches the Reason field", async () => {
  const posts = setupPause(() => ({ status: 200, body: null }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.click(screen.getByRole("button", { name: "Pause all seats" }));
  const summary = summaryOf();
  expect(document.activeElement).toBe(summary);
  const reason = screen.getByLabelText("Reason");
  expect(reason.getAttribute("aria-invalid")).toBe("true");
  expect(reason.getAttribute("aria-describedby")).toContain("-error");
  fireEvent.click(within(summary).getByRole("link", { name: "Enter a reason for the pause." }));
  expect(document.activeElement).toBe(reason);
  expect(posts).toHaveLength(0);
});

it("lays out scope, the seat summary, Reason, a read-only Duration, then the audit", async () => {
  stubFetch({
    "/api/config": CREW_CONFIG,
    "/api/settings/crew-pause": { seats: "all", reason: "Save tokens", by: "operator", at: 1 },
  });
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit crew pause" }));
  const dialog = screen.getByRole("dialog", { name: "Edit crew pause" });
  const order = [
    "Scope",
    "will pause.",
    "Reason",
    "Duration",
    "Until resumed",
    "No automatic expiry",
    "Run exceptions",
  ].map((text) => (dialog.textContent ?? "").indexOf(text));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const duration = within(dialog).getByRole("group", { name: "Duration" });
  expect(duration.querySelector("input, select, button")).toBeNull();
  expect(dialog.querySelector('input[type="date"], input[type="datetime-local"]')).toBeNull();
  const audit = within(dialog).getByRole("region", { name: "Crew pause audit" });
  expect(audit.contains(screen.getByLabelText("Reason"))).toBe(false);
});

it("summarises the selected seats", async () => {
  setupPause(() => ({ status: 200, body: null }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  expect(screen.getByRole("status", { name: "" }).textContent).toMatch(
    /^All \d+ seats? will pause\.$/,
  );
  fireEvent.click(screen.getByLabelText("All seats"));
  expect(screen.getByText("No seats selected.")).toBeTruthy();
  const seat = CREW_CONFIG.crew?.sessions[0]?.seats[0];
  if (!seat) throw new Error("missing fixture seat");
  fireEvent.click(screen.getByLabelText(seat.id));
  expect(screen.getByText(new RegExp(`will pause: ${seat.id}\\.$`))).toBeTruthy();
});

it("a refused save keeps the draft and says why in the summary", async () => {
  const posts = setupPause(() => ({
    status: 409,
    body: { error: "Another pause is being saved" },
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Save tokens" } });
  fireEvent.click(screen.getByRole("button", { name: "Pause all seats" }));
  const summary = await waitFor(summaryOf);
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect(summary.textContent).toContain("Another pause is being saved");
  expect(summary.textContent).not.toContain("result is unknown");
  expect((screen.getByLabelText("Reason") as HTMLInputElement).value).toBe("Save tokens");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(posts).toHaveLength(1);
});

it("a lost connection keeps the draft and says the result is unknown", async () => {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(input === "/api/config" ? CREW_CONFIG : null), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Save tokens" } });
  fireEvent.click(screen.getByRole("button", { name: "Pause all seats" }));
  const summary = await waitFor(summaryOf);
  expect(summary.textContent).toContain("Failed to fetch");
  expect(summary.textContent).toContain("The result is unknown");
  expect((screen.getByLabelText("Reason") as HTMLInputElement).value).toBe("Save tokens");
  expect((screen.getByLabelText("All seats") as HTMLInputElement).checked).toBe(true);
});

it("a double submit posts once", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(init.body);
        await held;
        return new Response("null", { status: 200 });
      }
      return new Response(JSON.stringify(input === "/api/config" ? CREW_CONFIG : null), {
        status: 200,
      });
    }),
  );
  render(<CrewPauseControl />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause crew" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Save tokens" } });
  const form = screen.getByLabelText("Reason").closest("form") as HTMLFormElement;
  fireEvent.submit(form);
  fireEvent.submit(form);
  fireEvent.click(screen.getByRole("button", { name: "Pause all seats" }));
  release();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(posts).toHaveLength(1);
});

it("Esc closes the modal, keeps Tab inside it and returns focus to the opener", async () => {
  stubFetch({ "/api/config": CREW_CONFIG, "/api/settings/crew-pause": null });
  render(<CrewPauseControl />);
  const noop = () => {};
  const off = installKeys({
    navigate: noop,
    toggleDock: noop,
    help: noop,
    selectNext: noop,
    selectPrev: noop,
    toast: noop,
  });
  const opener = await screen.findByRole("button", { name: "Pause crew" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Pause crew" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();
  expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(screen.getByLabelText("All seats"));
  expect(dialog.closest(".modal")).toBeTruthy();
  act(() => {
    fireEvent.keyDown(document.body, { key: "Escape" });
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  off();
});
