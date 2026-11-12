import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { CommsChartPage } from "../src/pages/CommsChartPage.tsx";
import { stubFetch } from "./fetchStub.ts";
import { seatRow } from "./fixtures.ts";

afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const rows = [
  seatRow({ id: "flight-1", index: 0, role: "FLIGHT" }),
  seatRow({ id: "guido-1", index: 1 }),
  seatRow({ id: "retro-1", index: 2, role: "RETRO" }),
];

function open(search = "", over: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", `/comms/chart${search}`);
  stubFetch({
    "/api/crew?shape=summary": { rows, firstRunToday: null },
    "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 3 }] },
    "/api/comms/open": { items: [] },
    "/api/comms/feed": { messages: [] },
    ...over,
  });
  return render(<CommsChartPage />);
}

it("narrows to a seat on a click and clears on a second click of the same seat", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: /^guido-1,/i }));
  await waitFor(() => expect(window.location.search).toBe("?focus=seat%3Aguido-1"));
  expect(await screen.findByRole("complementary", { name: /conversation/i })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^guido-1,/i }));
  await waitFor(() => expect(window.location.search).toBe(""));
  expect(screen.queryByRole("complementary", { name: /conversation/i })).toBeNull();
});

it("narrows to a link, and a second click on it clears", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: /^guido-1 ↔ retro-1,/i }));
  await waitFor(() => expect(window.location.search).toBe("?focus=pair%3Aguido-1%2Cretro-1"));
  fireEvent.click(screen.getByRole("button", { name: /^guido-1 ↔ retro-1,/i }));
  await waitFor(() => expect(window.location.search).toBe(""));
});

it("starts narrowed when opened with a filter in the address, and Escape clears it", async () => {
  open("?focus=seat:retro-1");
  expect(await screen.findByRole("complementary", { name: /conversation/i })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(window.location.search).toBe(""));
});

it("links back to Comms", async () => {
  open();
  expect((await screen.findByRole("link", { name: /← comms/i })).getAttribute("href")).toBe(
    "/comms",
  );
});

it("shows Waiting on a reply and Just said beside the graph, and opens the conversation from them", async () => {
  open("", {
    "/api/comms/open": {
      items: [
        {
          id: "ask",
          label: "question",
          from: "guido-1",
          to: "retro-1",
          ticket: null,
          waitedMs: 5 * 60_000,
          question: "Which branch?",
        },
      ],
    },
    "/api/comms/feed": {
      messages: [{ id: "m1", from: "retro-1", to: "guido-1", at: 1, text: "On main\nsecond line" }],
    },
  });
  const waiting = await screen.findByRole("region", { name: "Waiting on a reply" });
  expect(waiting.textContent).toContain("5m");
  expect(waiting.textContent).toContain("Which branch?");
  const said = screen.getByRole("region", { name: "Just said" });
  expect(said.textContent).toContain("On main");
  expect(said.textContent).not.toContain("second line");
  fireEvent.click(within(said).getByRole("button"));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/comms/agents/guido-1/contacts/retro-1"),
  );
});

it("says so when there is nothing waiting or said", async () => {
  open();
  expect(await screen.findByText("Nobody owes a reply.")).toBeTruthy();
  expect(screen.getByText("No direct messages yet.")).toBeTruthy();
});

it("says the links could not be loaded, rather than drawing an empty graph", async () => {
  open("", { "/api/comms/links": () => ({ status: 500, body: { error: "down" } }) });
  expect(await screen.findByText(/couldn't load comms graph/i)).toBeTruthy();
  expect(document.querySelector(".comms-node")).toBeNull();
});

it("has no play control and no timeline", async () => {
  open();
  await screen.findByRole("button", { name: /^guido-1,/i });
  expect(screen.queryByRole("button", { name: /^(play|pause|resume|replay)\b/i })).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(document.querySelector("[class*=timeline], [class*=scrub]")).toBeNull();
});
